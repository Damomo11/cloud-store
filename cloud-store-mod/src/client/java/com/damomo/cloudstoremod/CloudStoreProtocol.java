package com.damomo.cloudstoremod;

import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.security.InvalidKeyException;
import java.security.NoSuchAlgorithmException;
import java.time.Instant;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.GZIPInputStream;

public final class CloudStoreProtocol {
    private static final Pattern CHUNK_PATTERN = Pattern.compile(".*?\\bCS1\\s+(\\S{2,32})\\s+(\\d{1,3})/(\\d{1,3})\\s+(?:(\\S{16,128})\\s+)?(\\S+)\\s*$");
    private static final Pattern QUOTA_PATTERN = Pattern.compile("\"usedSlots\"\\s*:\\s*(\\d+).*?\"quotaSlots\"\\s*:\\s*(\\d+)", Pattern.DOTALL);
    private static final Pattern ITEM_PATTERN = Pattern.compile("\\{[^{}]*\"(?:name|displayName)\"\\s*:\\s*\"([^\"]+)\"[^{}]*\"amount\"\\s*:\\s*(\\d+)[^{}]*}");
    private static final Pattern CODE_PATTERN = Pattern.compile("\"code\"\\s*:\\s*\"([^\"]+)\"");

    private final Map<String, ChunkSession> sessions = new HashMap<>();
    private SyncSnapshot latestSnapshot;
    private String latestNotice = "还没有收到余量数据。";

    public synchronized ParseResult acceptMessage(String rawMessage, String secret) {
        Matcher matcher = CHUNK_PATTERN.matcher(rawMessage);
        if (!matcher.matches()) {
            return ParseResult.ignored();
        }

        String sessionId = matcher.group(1);
        int index = parseInt(matcher.group(2));
        int total = parseInt(matcher.group(3));
        String signature = matcher.group(4);
        String payload = matcher.group(5);

        if (index <= 0 || total <= 0 || index > total || total > 99) {
            latestNotice = "收到余量码，但分片编号不合法。";
            return ParseResult.error(latestNotice);
        }

        if (secret != null && !secret.isBlank() && signature != null && !verify(secret, sessionId, index, total, payload, signature)) {
            latestNotice = "收到余量码，但签名校验失败。";
            return ParseResult.error(latestNotice);
        }

        ChunkSession session = sessions.computeIfAbsent(sessionId, id -> new ChunkSession(total));
        if (session.total != total) {
            sessions.remove(sessionId);
            latestNotice = "收到余量码，但同一会话分片总数不一致。";
            return ParseResult.error(latestNotice);
        }

        session.parts.put(index, payload);
        latestNotice = "正在接收余量数据：" + session.parts.size() + "/" + total;

        if (session.parts.size() < total) {
            return ParseResult.partial(latestNotice);
        }

        StringBuilder encoded = new StringBuilder();
        for (int i = 1; i <= total; i++) {
            String part = session.parts.get(i);
            if (part == null) {
                latestNotice = "余量数据缺少第 " + i + " 段。";
                return ParseResult.error(latestNotice);
            }
            encoded.append(part);
        }

        try {
            String json = ungzipBase64Url(encoded.toString());
            latestSnapshot = SyncSnapshot.fromJson(json);
            latestNotice = "余量更新完成：" + latestSnapshot.summary;
            sessions.remove(sessionId);
            return ParseResult.complete(latestSnapshot);
        } catch (RuntimeException | IOException e) {
            latestNotice = "余量数据解码失败：" + e.getMessage();
            sessions.remove(sessionId);
            return ParseResult.error(latestNotice);
        }
    }

    public synchronized SyncSnapshot latestSnapshot() {
        return latestSnapshot;
    }

    public synchronized String latestNotice() {
        return latestNotice;
    }

    public synchronized void clear() {
        sessions.clear();
        latestSnapshot = null;
        latestNotice = "已清空余量缓存。";
    }

    private static boolean verify(String secret, String sessionId, int index, int total, String payload, String signature) {
        try {
            Mac mac = Mac.getInstance("HmacSHA256");
            mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
            String body = sessionId + ":" + index + "/" + total + ":" + payload;
            String expected = Base64.getUrlEncoder().withoutPadding().encodeToString(mac.doFinal(body.getBytes(StandardCharsets.UTF_8)));
            return constantTimeEquals(expected, signature);
        } catch (NoSuchAlgorithmException | InvalidKeyException e) {
            return false;
        }
    }

    private static boolean constantTimeEquals(String a, String b) {
        if (a == null || b == null) {
            return false;
        }
        int diff = a.length() ^ b.length();
        int max = Math.max(a.length(), b.length());
        for (int i = 0; i < max; i++) {
            char ca = i < a.length() ? a.charAt(i) : 0;
            char cb = i < b.length() ? b.charAt(i) : 0;
            diff |= ca ^ cb;
        }
        return diff == 0;
    }

    private static String ungzipBase64Url(String encoded) throws IOException {
        byte[] compressed = Base64.getUrlDecoder().decode(encoded);
        try (GZIPInputStream gzip = new GZIPInputStream(new ByteArrayInputStream(compressed))) {
            return new String(gzip.readAllBytes(), StandardCharsets.UTF_8);
        }
    }

    private static int parseInt(String text) {
        try {
            return Integer.parseInt(text);
        } catch (NumberFormatException e) {
            return -1;
        }
    }

    private static String unescapeJson(String text) {
        return text.replace("\\\"", "\"").replace("\\n", "\n").replace("\\\\", "\\");
    }

    private static final class ChunkSession {
        final int total;
        final Map<Integer, String> parts = new HashMap<>();

        ChunkSession(int total) {
            this.total = total;
        }
    }

    public record ParseResult(boolean matched, boolean complete, String message, SyncSnapshot snapshot) {
        static ParseResult ignored() {
            return new ParseResult(false, false, "", null);
        }

        static ParseResult partial(String message) {
            return new ParseResult(true, false, message, null);
        }

        static ParseResult complete(SyncSnapshot snapshot) {
            return new ParseResult(true, true, "余量更新完成", snapshot);
        }

        static ParseResult error(String message) {
            return new ParseResult(true, false, message, null);
        }
    }

    public static final class SyncSnapshot {
        public final String rawJson;
        public final String summary;
        public final List<String> lines;
        public final Instant receivedAt;

        private SyncSnapshot(String rawJson, String summary, List<String> lines) {
            this.rawJson = rawJson;
            this.summary = summary;
            this.lines = lines;
            this.receivedAt = Instant.now();
        }

        static SyncSnapshot fromJson(String json) {
            List<String> lines = new ArrayList<>();
            Matcher quotaMatcher = QUOTA_PATTERN.matcher(json);
            if (quotaMatcher.find()) {
                lines.add("额度：" + quotaMatcher.group(1) + "/" + quotaMatcher.group(2) + " 格");
            }

            Matcher itemMatcher = ITEM_PATTERN.matcher(json);
            while (itemMatcher.find() && lines.size() < 80) {
                String itemBlock = itemMatcher.group(0);
                Matcher codeMatcher = CODE_PATTERN.matcher(itemBlock);
                String code = codeMatcher.find() ? " [" + unescapeJson(codeMatcher.group(1)) + "]" : "";
                lines.add(unescapeJson(itemMatcher.group(1)) + code + " x" + itemMatcher.group(2));
            }

            if (lines.isEmpty()) {
                lines.add(json.length() > 500 ? json.substring(0, 500) + "..." : json);
            }

            String summary = lines.get(0);
            if (lines.size() > 1) {
                summary += "，物品 " + (lines.size() - 1) + " 行";
            }
            return new SyncSnapshot(json, summary, lines);
        }
    }
}
