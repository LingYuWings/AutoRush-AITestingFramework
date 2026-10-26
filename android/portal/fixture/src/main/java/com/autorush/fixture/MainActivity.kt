package com.autorush.fixture

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.text.InputType
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView

/** A local-only, disposable fixture: no network, storage or account permissions. */
class MainActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val root = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(16), dp(16), dp(16), dp(16))
        }
        root.addView(TextView(this).apply { text = "AutoRush Test Fixture"; textSize = 22f })
        val name = EditText(this).apply {
            id = R.id.name
            hint = "Test name"
            inputType = InputType.TYPE_CLASS_TEXT
            setSingleLine(true)
        }
        root.addView(name)
        root.addView(EditText(this).apply {
            id = R.id.secret
            setSingleLine(true)
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            transformationMethod = android.text.method.PasswordTransformationMethod.getInstance()
            setText("fixture-secret-123")
        })
        val status = TextView(this).apply { id = R.id.status; text = "Waiting"; textSize = 18f; setPadding(0, dp(12), 0, dp(12)) }
        root.addView(Button(this).apply {
            id = R.id.submit; text = "Submit"
            setOnClickListener { status.text = "Submitted: ${name.text}" }
        })
        root.addView(status)
        root.addView(Button(this).apply {
            id = R.id.details; text = "Open details"
            setOnClickListener { startActivity(Intent(this@MainActivity, DetailsActivity::class.java)) }
        })
        root.addView(Button(this).apply {
            id = R.id.reset; text = "Reset"
            setOnClickListener { name.setText(""); status.text = "Waiting" }
        })
        val items = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            for (index in 1..6) addView(TextView(this@MainActivity).apply {
                text = "Scroll item $index"; textSize = 18f
            }, LinearLayout.LayoutParams(-1, dp(90)))
            addView(TextView(this@MainActivity).apply { id = R.id.bottom; text = "End of list"; textSize = 18f }, LinearLayout.LayoutParams(-1, dp(52)))
        }
        root.addView(ScrollView(this).apply { id = R.id.scroll_area; addView(items) }, LinearLayout.LayoutParams(-1, 0, 1f))
        setContentView(root)
    }

    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
}

class DetailsActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(TextView(this).apply { id = R.id.details_title; text = "Details"; textSize = 26f; setPadding(40, 100, 40, 40) })
    }
}
