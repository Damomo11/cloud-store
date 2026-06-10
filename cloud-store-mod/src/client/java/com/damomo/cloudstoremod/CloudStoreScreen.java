package com.damomo.cloudstoremod;

import net.minecraft.client.MinecraftClient;
import net.minecraft.client.gui.DrawContext;
import net.minecraft.client.gui.screen.Screen;
import net.minecraft.client.gui.widget.ButtonWidget;
import net.minecraft.client.gui.widget.TextFieldWidget;
import net.minecraft.text.Text;

import java.util.List;

public final class CloudStoreScreen extends Screen {
    private static final int FIELD_H = 20;
    private static final int GAP = 6;

    private final CloudStoreConfig config;
    private Tab tab = Tab.ACTIONS;

    private TextFieldWidget personalQueryField;
    private TextFieldWidget personalWithdrawField;
    private TextFieldWidget orgQueryField;
    private TextFieldWidget orgWithdrawField;
    private TextFieldWidget botField;
    private TextFieldWidget orgAddField;

    public CloudStoreScreen(CloudStoreConfig config) {
        super(Text.translatable("cloud_store_mod.title"));
        this.config = config;
    }

    @Override
    protected void init() {
        rebuild();
    }

    private void rebuild() {
        clearChildren();
        int left = panelLeft();
        int top = 34;

        addButton(left, 10, 88, "操作", () -> switchTab(Tab.ACTIONS));
        addButton(left + 94, 10, 88, "设置", () -> switchTab(Tab.SETTINGS));

        if (tab == Tab.ACTIONS) {
            buildActions(left, top);
        } else {
            buildSettings(left, top);
        }
    }

    private void buildActions(int left, int top) {
        int width = panelWidth();
        sectionTitle(left, top, "个人仓库");
        addButton(left, top + 16, 120, "个人存入", () -> send("存"));

        personalQueryField = field(left, top + 40, width - 58, "查询物品，例如 石头 / 451038");
        addButton(left + width - 52, top + 40, 52, "查询", () -> queryPersonal());
        personalWithdrawField = field(left, top + 64, width - 58, "取出，例如 石头64 红石块3 451038 1");
        addButton(left + width - 52, top + 64, 52, "取出", () -> withdrawPersonal());

        sectionTitle(left, top + 96, "组织仓库");
        addButton(left, top + 112, 58, "上一个", () -> cycleWarehouse(-1));
        addButton(left + 64, top + 112, width - 128, currentWarehouseLabel(), () -> {});
        addButton(left + width - 58, top + 112, 58, "下一个", () -> cycleWarehouse(1));

        addButton(left, top + 136, 120, "组织存入", () -> depositOrg());
        orgQueryField = field(left, top + 160, width - 58, "查询组织物品");
        addButton(left + width - 52, top + 160, 52, "查询", () -> queryOrg());
        orgWithdrawField = field(left, top + 184, width - 58, "取出，例如 石头64 红石块3");
        addButton(left + width - 52, top + 184, 52, "取出", () -> withdrawOrg());
    }

    private void buildSettings(int left, int top) {
        int width = panelWidth();
        sectionTitle(left, top, "机器人");
        botField = field(left, top + 16, width - 76, "机器人名字");
        botField.setText(config.botName == null ? "" : config.botName);
        addButton(left + width - 70, top + 16, 70, "保存", () -> saveSettings());

        sectionTitle(left, top + 56, "组织列表");
        orgAddField = field(left, top + 72, width - 146, "组织仓库名，最多15字，不能有空格");
        addButton(left + width - 140, top + 72, 68, "添加", () -> addWarehouse());
        addButton(left + width - 66, top + 72, 66, "删除", () -> removeWarehouse());

        int y = top + 108;
        List<String> names = config.normalizedWarehouses();
        if (names.isEmpty()) {
            addStatusText("还没有添加组织仓库。");
        } else {
            for (int i = 0; i < Math.min(names.size(), 5); i++) {
                String name = names.get(i);
                int rowY = y + i * 24;
                addButton(left, rowY, width - 70, name.equals(config.lastWarehouse) ? "* " + name : name, () -> selectWarehouse(name));
                addButton(left + width - 64, rowY, 64, "删除", () -> {
                    config.removeWarehouse(name);
                    rebuild();
                });
            }
        }
    }

    private TextFieldWidget field(int x, int y, int w, String placeholder) {
        TextFieldWidget widget = new TextFieldWidget(textRenderer, x, y, w, FIELD_H, Text.literal(placeholder));
        widget.setMaxLength(220);
        widget.setPlaceholder(Text.literal(placeholder));
        addDrawableChild(widget);
        return widget;
    }

    private void addButton(int x, int y, int w, String label, Runnable action) {
        addDrawableChild(ButtonWidget.builder(Text.literal(label), button -> action.run())
                .dimensions(x, y, w, FIELD_H)
                .build());
    }

    private void switchTab(Tab next) {
        saveTransientFields();
        tab = next;
        rebuild();
    }

    private void saveTransientFields() {
        if (botField != null) {
            config.botName = botField.getText().trim();
            config.save();
        }
    }

    private void saveSettings() {
        saveTransientFields();
        CloudStoreModClient.addStatus("设置已保存。");
    }

    private void queryPersonal() {
        String item = text(personalQueryField);
        if (item.isBlank()) {
            return;
        }
        send("查 " + item);
    }

    private void withdrawPersonal() {
        String request = text(personalWithdrawField);
        if (request.isBlank()) {
            return;
        }
        send("取 " + request);
    }

    private void depositOrg() {
        String warehouse = selectedWarehouse();
        if (warehouse.isBlank()) {
            CloudStoreModClient.addStatus("请先在设置里添加组织仓库。");
            return;
        }
        send(warehouse + " 存");
    }

    private void withdrawOrg() {
        String warehouse = selectedWarehouse();
        String request = text(orgWithdrawField);
        if (warehouse.isBlank()) {
            return;
        }
        if (request.isBlank()) {
            return;
        }
        send(warehouse + " 取 " + request);
    }

    private void queryOrg() {
        String warehouse = selectedWarehouse();
        String item = text(orgQueryField);
        if (warehouse.isBlank() || item.isBlank()) {
            return;
        }
        send(warehouse + " 查 " + item);
    }

    private void addWarehouse() {
        String name = text(orgAddField);
        if (config.addWarehouse(name)) {
            CloudStoreModClient.addStatus("已添加组织仓库：" + name.trim());
            rebuild();
        } else {
            CloudStoreModClient.addStatus("组织名不能为空，不能有空格，最多15字。");
        }
    }

    private void removeWarehouse() {
        String name = text(orgAddField);
        if (name.isBlank()) {
            name = selectedWarehouse();
        }
        if (config.removeWarehouse(name)) {
            CloudStoreModClient.addStatus("已删除组织仓库：" + name);
            rebuild();
        } else {
            CloudStoreModClient.addStatus("没有找到这个组织仓库。");
        }
    }

    private void selectWarehouse(String name) {
        config.lastWarehouse = name;
        config.save();
        rebuild();
    }

    private void cycleWarehouse(int direction) {
        List<String> names = config.normalizedWarehouses();
        if (names.isEmpty()) {
            CloudStoreModClient.addStatus("请先在设置里添加组织仓库。");
            return;
        }
        int index = names.indexOf(config.lastWarehouse);
        if (index < 0) {
            index = 0;
        } else {
            index = Math.floorMod(index + direction, names.size());
        }
        config.lastWarehouse = names.get(index);
        config.save();
        rebuild();
    }

    private String selectedWarehouse() {
        List<String> names = config.normalizedWarehouses();
        if (config.lastWarehouse != null && !config.lastWarehouse.isBlank() && names.contains(config.lastWarehouse)) {
            return config.lastWarehouse;
        }
        return names.isEmpty() ? "" : names.get(0);
    }

    private String currentWarehouseLabel() {
        String warehouse = selectedWarehouse();
        return warehouse.isBlank() ? "未设置组织" : warehouse;
    }

    private void send(String command) {
        saveTransientFields();
        CloudStoreModClient.sendBotCommand(command);
    }

    private static String text(TextFieldWidget widget) {
        return widget == null ? "" : widget.getText().trim();
    }

    private int panelLeft() {
        return Math.max(18, width / 2 - panelWidth() / 2);
    }

    private int panelWidth() {
        return Math.min(360, width - 36);
    }

    private void sectionTitle(int x, int y, String title) {
        addStatusText(title);
    }

    private void addStatusText(String ignored) {
    }

    @Override
    public void render(DrawContext context, int mouseX, int mouseY, float delta) {
        context.fill(0, 0, width, height, 0xCC101014);
        super.render(context, mouseX, mouseY, delta);

        int left = panelLeft();
        if (tab == Tab.ACTIONS) {
            drawSection(context, left, 34, "个人仓库");
            drawSection(context, left, 130, "组织仓库");
        } else {
            drawSection(context, left, 34, "机器人");
            drawSection(context, left, 90, "组织列表");
        }

    }

    private void drawSection(DrawContext context, int x, int y, String title) {
        context.drawText(textRenderer, title, x, y, 0xFFE6E6E6, false);
    }

    @Override
    public void close() {
        saveTransientFields();
        MinecraftClient.getInstance().setScreen(null);
    }

    private enum Tab {
        ACTIONS,
        SETTINGS
    }
}
