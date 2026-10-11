package com.saldev.webrtc.model;

import tools.jackson.databind.JsonNode;

/** Unverified browser-reported metadata, retained only for the room session. */
public record DeviceInfo(String type, String os, String browser, String model) {
    public DeviceInfo {
        type = sanitize(type);
        os = sanitize(os);
        browser = sanitize(browser);
        model = sanitize(model);
    }

    public static DeviceInfo unknown() {
        return new DeviceInfo(null, null, null, null);
    }

    public static DeviceInfo from(JsonNode node) {
        return new DeviceInfo(field(node, "type"), field(node, "os"), field(node, "browser"), field(node, "model"));
    }

    private static String field(JsonNode node, String name) {
        if (node == null || !node.isObject() || !node.path(name).isString()) return null;
        return node.path(name).asText();
    }

    private static String sanitize(String value) {
        if (value == null || value.isBlank()) return "Unknown / not provided";
        // Bound work and prevent injected lines or direction-control characters in alerts.
        String clean = value.substring(0, Math.min(value.length(), 100))
                .replaceAll("[\\p{Cntrl}\\p{Cf}\\p{Zl}\\p{Zp}]", " ").strip();
        return clean.isBlank() ? "Unknown / not provided" : clean;
    }

    public String alertText() {
        return "\nDevice (browser-reported): " + type + "\nOS: " + os
                + "\nBrowser: " + browser + "\nModel: " + model;
    }
}
