package com.cliprelay.app.data

import kotlin.math.roundToInt

object FullscreenTextSize {
    const val DEFAULT_SP = 17
    const val MIN_SP = 13
    const val MAX_SP = 29
    const val STEP_SP = 2

    fun normalize(value: Int): Int {
        val clamped = value.coerceIn(MIN_SP, MAX_SP)
        val step = ((clamped - MIN_SP).toFloat() / STEP_SP).roundToInt()
        return MIN_SP + step * STEP_SP
    }

    fun decrease(value: Int): Int = (normalize(value) - STEP_SP).coerceAtLeast(MIN_SP)

    fun increase(value: Int): Int = (normalize(value) + STEP_SP).coerceAtMost(MAX_SP)

    fun lineHeight(value: Int): Int = (normalize(value) * 1.5f).roundToInt()
}
