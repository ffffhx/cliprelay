package com.cliprelay.app.discovery

object ClipRelayDiscovery {
    const val SERVICE_TYPE = "_cliprelay._tcp."
    const val PROTOCOL_VERSION = "1"
    const val PLATFORM = "android"
    const val MAX_DEVICE_NAME_LENGTH = 32
    private const val MAX_IDENTITY_VALUE_LENGTH = 64

    fun normalizeDeviceName(value: String): String = value
        .trim()
        .replace(Regex("[\\r\\n\\u0000]"), "-")
        .ifEmpty { "Android" }
        .take(MAX_DEVICE_NAME_LENGTH)

    fun preferredBrand(brand: String, manufacturer: String): String =
        sequenceOf(brand, manufacturer)
            .map(::normalizeIdentityValue)
            .firstOrNull { it.isNotEmpty() && !it.equals("generic", ignoreCase = true) &&
                !it.equals("unknown", ignoreCase = true) }
            .orEmpty()

    fun modelName(model: String): String = normalizeIdentityValue(model)

    fun defaultDeviceName(brand: String, manufacturer: String, model: String): String {
        val resolvedBrand = preferredBrand(brand, manufacturer)
        val resolvedModel = modelName(model)
        val value = when {
            resolvedBrand.isEmpty() -> resolvedModel
            resolvedModel.isEmpty() -> resolvedBrand
            resolvedModel.equals(resolvedBrand, ignoreCase = true) ||
                resolvedModel.startsWith("$resolvedBrand ", ignoreCase = true) -> resolvedModel
            else -> "$resolvedBrand $resolvedModel"
        }
        return normalizeDeviceName(value)
    }

    fun txtRecords(
        deviceId: String,
        requiresAuth: Boolean,
        brand: String,
        model: String,
    ): Map<String, String> = linkedMapOf(
        "id" to deviceId.trim(),
        "version" to PROTOCOL_VERSION,
        "platform" to PLATFORM,
        "auth" to if (requiresAuth) "required" else "none",
    ).apply {
        preferredBrand(brand, "").takeIf(String::isNotEmpty)?.let { put("brand", it) }
        modelName(model).takeIf(String::isNotEmpty)?.let { put("model", it) }
    }

    private fun normalizeIdentityValue(value: String): String = value
        .trim()
        .replace(Regex("[\\r\\n\\u0000]"), "-")
        .take(MAX_IDENTITY_VALUE_LENGTH)
}
