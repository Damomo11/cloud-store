package com.damomo.cloudstoremod;

import net.fabricmc.loader.api.FabricLoader;

import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.List;
import java.util.Properties;
import java.util.stream.Collectors;

public final class CloudStoreConfig {
    private static final Path CONFIG_PATH = FabricLoader.getInstance()
            .getConfigDir()
            .resolve("cloud-store-mod.properties");

    public String botName = "NanKinz1";
    public String lastWarehouse = "";
    public String syncSecret = "";
    public List<String> warehouseNames = new ArrayList<>();

    public static CloudStoreConfig load() {
        CloudStoreConfig config = new CloudStoreConfig();
        if (!Files.exists(CONFIG_PATH)) {
            config.save();
            return config;
        }

        Properties properties = new Properties();
        try (InputStream input = Files.newInputStream(CONFIG_PATH)) {
            properties.load(input);
            config.botName = properties.getProperty("botName", config.botName).trim();
            config.lastWarehouse = properties.getProperty("lastWarehouse", config.lastWarehouse).trim();
            config.syncSecret = properties.getProperty("syncSecret", config.syncSecret).trim();
            config.warehouseNames = parseWarehouses(properties.getProperty("warehouseNames", ""));
        } catch (IOException ignored) {
        }

        if (config.botName.isBlank()) {
            config.botName = "NanKinz1";
        }
        config.ensureLastWarehouseInList();
        return config;
    }

    public void save() {
        Properties properties = new Properties();
        properties.setProperty("botName", botName == null ? "" : botName.trim());
        properties.setProperty("lastWarehouse", lastWarehouse == null ? "" : lastWarehouse.trim());
        properties.setProperty("syncSecret", syncSecret == null ? "" : syncSecret.trim());
        properties.setProperty("warehouseNames", String.join("\n", normalizedWarehouses()));

        try {
            Files.createDirectories(CONFIG_PATH.getParent());
            try (OutputStream output = Files.newOutputStream(CONFIG_PATH)) {
                properties.store(output, "Cloud Store Mod");
            }
        } catch (IOException ignored) {
        }
    }

    public List<String> normalizedWarehouses() {
        return warehouseNames.stream()
                .map(String::trim)
                .filter(name -> !name.isBlank())
                .distinct()
                .collect(Collectors.toCollection(ArrayList::new));
    }

    public boolean addWarehouse(String name) {
        String clean = name == null ? "" : name.trim();
        if (clean.isBlank() || clean.contains(" ") || clean.length() > 15) {
            return false;
        }
        warehouseNames = normalizedWarehouses();
        if (!warehouseNames.contains(clean)) {
            warehouseNames.add(clean);
        }
        lastWarehouse = clean;
        save();
        return true;
    }

    public boolean removeWarehouse(String name) {
        String clean = name == null ? "" : name.trim();
        if (clean.isBlank()) {
            return false;
        }
        warehouseNames = normalizedWarehouses();
        boolean removed = warehouseNames.removeIf(existing -> existing.equals(clean));
        if (lastWarehouse.equals(clean)) {
            lastWarehouse = warehouseNames.isEmpty() ? "" : warehouseNames.get(0);
        }
        save();
        return removed;
    }

    private void ensureLastWarehouseInList() {
        warehouseNames = normalizedWarehouses();
        if (!lastWarehouse.isBlank() && !warehouseNames.contains(lastWarehouse)) {
            warehouseNames.add(lastWarehouse);
        }
        if (lastWarehouse.isBlank() && !warehouseNames.isEmpty()) {
            lastWarehouse = warehouseNames.get(0);
        }
    }

    private static List<String> parseWarehouses(String raw) {
        if (raw == null || raw.isBlank()) {
            return new ArrayList<>();
        }
        return Arrays.stream(raw.split("\\R"))
                .map(String::trim)
                .filter(name -> !name.isBlank())
                .distinct()
                .collect(Collectors.toCollection(ArrayList::new));
    }
}
