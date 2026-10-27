package com.cliprelay.app.ui

import com.limelight.nvstream.http.ComputerDetails

data class HomeComputer(
    val uuid: String,
    val name: String,
    val state: ComputerDetails.State,
) {
    val displayName: String get() = name.replaceFirst(Regex("^ClipRelay\\s*[-–—]\\s*", RegexOption.IGNORE_CASE), "").ifBlank { name }
}

/** Discovery also persists peers in the engine DB. Home membership is explicit. */
class DeviceDirectory(initialSavedIds: Set<String>) {
    var savedIds: Set<String> = initialSavedIds.toSet()
        private set
    private val computers = linkedMapOf<String, HomeComputer>()
    private val removedIds = mutableSetOf<String>()

    fun update(computer: HomeComputer, explicitlyAdded: Boolean = false) {
        computers[computer.uuid] = computer
        if (explicitlyAdded && computer.uuid !in removedIds) add(computer.uuid)
    }

    fun add(uuid: String) {
        savedIds = savedIds + uuid
        removedIds.remove(uuid)
    }

    fun remove(uuid: String) {
        savedIds = savedIds - uuid
        computers.remove(uuid)
        removedIds.add(uuid)
    }

    fun saved(): List<HomeComputer> = computers.values.filter { it.uuid in savedIds }.sortedBy { it.displayName.lowercase() }
    fun nearby(): List<HomeComputer> = computers.values.filter {
        it.uuid !in savedIds && it.state == ComputerDetails.State.ONLINE
    }.sortedBy { it.displayName.lowercase() }
}
