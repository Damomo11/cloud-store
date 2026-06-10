package com.damomo.cloudstoremod;

import net.fabricmc.api.ClientModInitializer;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keybinding.v1.KeyBindingHelper;
import net.fabricmc.fabric.api.client.message.v1.ClientReceiveMessageEvents;
import net.minecraft.client.MinecraftClient;
import net.minecraft.client.option.KeyBinding;
import net.minecraft.client.util.InputUtil;
import net.minecraft.text.Text;
import org.lwjgl.glfw.GLFW;

import java.util.ArrayList;
import java.util.Collections;
import java.util.List;

public final class CloudStoreModClient implements ClientModInitializer {
    public static final String MOD_ID = "cloud_store_mod";
    public static final CloudStoreProtocol PROTOCOL = new CloudStoreProtocol();

    private static final List<String> STATUS_LINES = new ArrayList<>();
    private static CloudStoreConfig config;
    private static KeyBinding openKey;

    @Override
    public void onInitializeClient() {
        config = CloudStoreConfig.load();

        openKey = KeyBindingHelper.registerKeyBinding(new KeyBinding(
                "key.cloud_store_mod.open",
                InputUtil.Type.KEYSYM,
                GLFW.GLFW_KEY_Y,
                KeyBinding.Category.MISC
        ));

        ClientTickEvents.END_CLIENT_TICK.register(client -> {
            while (openKey.wasPressed()) {
                client.setScreen(new CloudStoreScreen(config));
            }
        });

        ClientReceiveMessageEvents.GAME.register((message, overlay) -> acceptIncomingText(message));
        ClientReceiveMessageEvents.CHAT.register((message, signedMessage, sender, params, receptionTimestamp) -> acceptIncomingText(message));
    }

    public static CloudStoreConfig config() {
        if (config == null) {
            config = CloudStoreConfig.load();
        }
        return config;
    }

    public static void sendBotCommand(String command) {
        MinecraftClient client = MinecraftClient.getInstance();
        CloudStoreConfig current = config();
        if (client.player == null || client.player.networkHandler == null) {
            addStatus("还没有进入服务器，无法发送命令。");
            return;
        }

        String botName = current.botName == null ? "" : current.botName.trim();
        if (botName.isBlank()) {
            addStatus("请先在设置里填写机器人名字。");
            return;
        }

        String clean = command == null ? "" : command.trim();
        if (clean.startsWith("/")) {
            clean = clean.substring(1).trim();
        }
        if (clean.startsWith("!")) {
            clean = clean.substring(1).trim();
        }
        if (clean.isBlank()) {
            addStatus("命令为空。");
            return;
        }

        current.save();
        client.player.networkHandler.sendChatCommand("msg " + botName + " " + clean);
        addStatus("已发送给 " + botName + "：" + clean);
    }

    public static void addStatus(String line) {
        synchronized (STATUS_LINES) {
            STATUS_LINES.add(0, line);
            while (STATUS_LINES.size() > 8) {
                STATUS_LINES.remove(STATUS_LINES.size() - 1);
            }
        }
    }

    public static List<String> statusLines() {
        synchronized (STATUS_LINES) {
            return Collections.unmodifiableList(new ArrayList<>(STATUS_LINES));
        }
    }

    private static void acceptIncomingText(Text message) {
        CloudStoreProtocol.ParseResult result = PROTOCOL.acceptMessage(message.getString(), config().syncSecret);
        if (result.matched()) {
            addStatus(result.message());
        }
    }
}
