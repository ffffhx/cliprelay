package com.limelight.preferences;

import android.app.Activity;
import android.app.Service;
import android.content.ComponentName;
import android.content.Context;
import android.content.Intent;
import android.content.ServiceConnection;
import android.os.Bundle;
import android.os.IBinder;
import android.text.Editable;
import android.text.TextWatcher;
import android.view.KeyEvent;
import android.view.View;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputMethodManager;
import android.widget.Button;
import android.widget.EditText;
import android.widget.TextView;
import android.widget.Toast;

import com.limelight.R;
import com.limelight.computers.ComputerManagerService;
import com.limelight.nvstream.http.ComputerDetails;
import com.limelight.ui.RemoteUi;
import com.limelight.utils.UiHelper;

public class AddComputerManually extends Activity {
    private EditText hostText;
    private TextView message;
    private Button addButton;
    private View progress;
    private ComputerManagerService.ComputerManagerBinder managerBinder;
    private boolean serviceBound;
    private Thread addThread;
    // UI-thread generation prevents cancelled work from changing a newer request's UI.
    private int generation;

    private final ServiceConnection serviceConnection = new ServiceConnection() {
        public void onServiceConnected(ComponentName name, IBinder binder) {
            managerBinder = (ComputerManagerService.ComputerManagerBinder) binder;
            setConnecting(addThread != null);
        }

        public void onServiceDisconnected(ComponentName name) {
            managerBinder = null;
            cancelConnection(false);
        }
    };

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        UiHelper.setLocale(this);
        setContentView(R.layout.activity_add_computer_manually);
        RemoteUi.apply(this);

        hostText = findViewById(R.id.hostTextView);
        message = findViewById(R.id.remoteAddressMessage);
        addButton = findViewById(R.id.addPcButton);
        progress = findViewById(R.id.remoteConnectProgress);
        addButton.setOnClickListener(v -> submit());
        findViewById(R.id.remoteCancelConnect).setOnClickListener(v -> cancelConnection(true));
        hostText.setOnEditorActionListener((view, actionId, event) -> {
            if (actionId == EditorInfo.IME_ACTION_DONE ||
                    (event != null && event.getAction() == KeyEvent.ACTION_DOWN &&
                            event.getKeyCode() == KeyEvent.KEYCODE_ENTER)) {
                submit();
                return true;
            }
            return false;
        });
        hostText.addTextChangedListener(new TextWatcher() {
            public void beforeTextChanged(CharSequence text, int start, int count, int after) {}
            public void onTextChanged(CharSequence text, int start, int before, int count) {
                message.setVisibility(View.GONE);
            }
            public void afterTextChanged(Editable text) {}
        });
        setConnecting(false);
        serviceBound = bindService(new Intent(this, ComputerManagerService.class),
                serviceConnection, Service.BIND_AUTO_CREATE);
    }

    private void submit() {
        if (addThread != null || managerBinder == null) return;
        String raw = hostText.getText().toString().trim();
        if (raw.isEmpty()) {
            showMessage(R.string.remote_address_required, true);
            return;
        }
        final ComputerDetails.AddressTuple address;
        try {
            address = RemoteAddress.parse(raw);
        } catch (IllegalArgumentException invalid) {
            showMessage(R.string.remote_address_invalid, true);
            return;
        }

        ((InputMethodManager) getSystemService(Context.INPUT_METHOD_SERVICE))
                .hideSoftInputFromWindow(hostText.getWindowToken(), 0);
        message.setVisibility(View.GONE);
        setConnecting(true);
        final int request = ++generation;
        final ComputerManagerService.ComputerManagerBinder binder = managerBinder;
        addThread = new Thread(() -> {
            boolean success;
            try {
                ComputerDetails details = new ComputerDetails();
                details.manualAddress = address;
                success = binder.addComputerBlocking(details);
            } catch (InterruptedException cancelled) {
                Thread.currentThread().interrupt();
                return;
            } catch (IllegalArgumentException invalid) {
                success = false;
            }
            final boolean connected = success;
            runOnUiThread(() -> {
                if (request != generation || isFinishing() || isDestroyed()) return;
                addThread = null;
                setConnecting(false);
                if (connected) {
                    Toast.makeText(this, R.string.addpc_success, Toast.LENGTH_SHORT).show();
                    finish();
                } else {
                    showMessage(R.string.remote_connect_failed, true);
                }
            });
        }, "ClipRelay - Add computer");
        addThread.start();
    }

    private void setConnecting(boolean connecting) {
        hostText.setEnabled(!connecting);
        addButton.setEnabled(!connecting && managerBinder != null);
        addButton.setAlpha(addButton.isEnabled() ? 1f : 0.6f);
        addButton.setText(connecting ? R.string.remote_connect_busy : R.string.remote_add);
        progress.setVisibility(connecting ? View.VISIBLE : View.GONE);
    }

    private void showMessage(int text, boolean error) {
        message.setText(text);
        message.setTextColor(getColor(error ? R.color.remote_error : R.color.remote_muted));
        message.setVisibility(View.VISIBLE);
    }

    private void cancelConnection(boolean notify) {
        generation++;
        Thread pending = addThread;
        addThread = null;
        if (pending != null) pending.interrupt();
        // Never join a network worker from a lifecycle callback on the UI thread.
        setConnecting(false);
        if (notify && pending != null) showMessage(R.string.remote_connect_cancelled, false);
    }

    @Override
    protected void onStop() {
        cancelConnection(!isFinishing());
        super.onStop();
    }

    @Override
    protected void onDestroy() {
        cancelConnection(false);
        if (serviceBound) {
            unbindService(serviceConnection);
            serviceBound = false;
        }
        super.onDestroy();
    }
}
