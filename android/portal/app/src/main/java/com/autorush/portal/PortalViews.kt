package com.autorush.portal

import android.content.Context
import android.content.res.ColorStateList
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.graphics.drawable.RippleDrawable
import android.os.Build
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.Switch
import android.widget.TextView

/** Provides consistent native controls and spacing for the Portal home and dialogs. */
internal class PortalViews(private val context: Context) {
    val background = Color.rgb(240, 245, 249)
    val white = Color.WHITE
    val muted = Color.rgb(74, 94, 112)
    val success = Color.rgb(0, 110, 92)
    val heroMuted = Color.rgb(190, 210, 227)
    val heroAccent = Color.rgb(155, 244, 206)
    private val ink = Color.rgb(19, 42, 62)
    private val hero = Color.rgb(20, 43, 66)
    private val border = Color.rgb(221, 231, 239)
    private val surface = Color.rgb(235, 243, 249)

    // Convert density-independent dimensions to pixels for Android views.
    fun dp(value: Int) = (value * context.resources.displayMetrics.density + .5f).toInt()

    // Apply consistent vertical margins to a full-width child.
    fun spaced(top: Int = 0, bottom: Int = 0) = LinearLayout.LayoutParams(-1, -2).apply {
        topMargin = dp(top)
        bottomMargin = dp(bottom)
    }

    // Build a vertical container for one group of controls.
    fun column() = LinearLayout(context).apply { orientation = LinearLayout.VERTICAL }

    // Give side-by-side status and action controls room for long labels.
    fun row(content: View, action: View) = LinearLayout(context).apply {
        gravity = Gravity.CENTER_VERTICAL
        addView(content, LinearLayout.LayoutParams(0, -2, 1f).apply { marginEnd = dp(12) })
        addView(action, LinearLayout.LayoutParams(-2, -2))
    }

    // Add a padded card with a light outline or the connection panel's dark fill.
    fun card(dark: Boolean = false) = column().apply {
        background = rounded(if (dark) hero else white, 22, if (dark) null else border)
        val padding = dp(if (dark) 22 else 16)
        setPadding(padding, padding, padding, padding)
    }

    // Style section text and expose it as a heading to Android accessibility.
    fun heading(value: String) = label(value, 18f, bold = true).apply {
        if (Build.VERSION.SDK_INT >= 28) isAccessibilityHeading = true
    }

    // Use scalable system typography for labels and status text.
    fun label(value: String, size: Float, color: Int = ink, bold: Boolean = false) = TextView(context).apply {
        text = value
        textSize = size
        setTextColor(color)
        if (bold) setTypeface(typeface, Typeface.BOLD)
    }

    // Draw a subtle boundary between independent settings in a card.
    fun divider() = View(context).apply {
        minimumHeight = dp(1)
        setBackgroundColor(border)
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    // Render actions with a ripple, visible focus, and at least a 48 dp touch target.
    fun action(value: String, primary: Boolean = false, action: () -> Unit) = Button(context).apply {
        text = value
        isAllCaps = false
        textSize = 14f
        setTypeface(typeface, Typeface.BOLD)
        setTextColor(ColorStateList(arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf()), intArrayOf(muted, ink)))
        minHeight = dp(48)
        minimumHeight = dp(48)
        minWidth = dp(72)
        setPadding(dp(14), dp(8), dp(14), dp(8))
        stateListAnimator = null
        background = RippleDrawable(ColorStateList.valueOf(0x2A132A3E),
            rounded(if (primary) heroAccent else surface, 14), null)
        setOnClickListener { action() }
    }

    // Keep toggles native so TalkBack announces their checked state and label together.
    fun toggle(value: String, checked: Boolean, changed: (Boolean) -> Unit) = Switch(context).apply {
        text = value
        textSize = 16f
        setTextColor(ink)
        setTypeface(typeface, Typeface.BOLD)
        minimumHeight = dp(48)
        switchPadding = dp(14)
        isChecked = checked
        val states = arrayOf(intArrayOf(-android.R.attr.state_enabled), intArrayOf(android.R.attr.state_checked), intArrayOf())
        thumbTintList = ColorStateList(states, intArrayOf(border, success, white))
        trackTintList = ColorStateList(states, intArrayOf(border, Color.rgb(157, 222, 200), Color.rgb(141, 161, 178)))
        setOnCheckedChangeListener { _, isChecked -> changed(isChecked) }
    }

    // Provide comfortable padding around native dialog form fields.
    fun dialogForm() = column().apply { setPadding(dp(24), dp(8), dp(24), dp(12)) }

    // Create an input whose keyboard and line count follow its field type.
    fun input(placeholder: String, value: String, type: Int) = EditText(context).apply {
        val multiline = type and InputType.TYPE_TEXT_FLAG_MULTI_LINE != 0
        setSingleLine(!multiline)
        inputType = type
        if (multiline) maxLines = 5
        minHeight = dp(50)
        textSize = 14f
        setTextColor(ink)
        setHintTextColor(muted)
        setPadding(dp(12), dp(10), dp(12), dp(10))
        background = rounded(surface, 12, border)
        hint = placeholder
        setText(value)
    }

    // Build a rounded surface with an optional border.
    private fun rounded(fill: Int, radius: Int, stroke: Int? = null) = GradientDrawable().apply {
        setColor(fill)
        cornerRadius = dp(radius).toFloat()
        stroke?.let { setStroke(dp(1), it) }
    }
}
