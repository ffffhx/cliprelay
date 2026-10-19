package com.limelight.ui;

import android.annotation.TargetApi;
import android.content.Context;
import android.util.AttributeSet;
import android.view.KeyEvent;
import android.view.SurfaceView;
import android.text.InputType;
import android.text.Editable;
import android.text.Selection;
import android.view.inputmethod.BaseInputConnection;
import android.view.inputmethod.EditorInfo;
import android.view.inputmethod.InputConnection;
import android.view.inputmethod.InputMethodManager;

public class StreamView extends SurfaceView {
    private double desiredAspectRatio;
    private InputCallbacks inputCallbacks;

    public void setDesiredAspectRatio(double aspectRatio) {
        this.desiredAspectRatio = aspectRatio;
    }

    public void setInputCallbacks(InputCallbacks callbacks) {
        this.inputCallbacks = callbacks;
    }

    public StreamView(Context context) {
        super(context);
    }

    public StreamView(Context context, AttributeSet attrs) {
        super(context, attrs);
    }

    public StreamView(Context context, AttributeSet attrs, int defStyleAttr) {
        super(context, attrs, defStyleAttr);
    }

    public StreamView(Context context, AttributeSet attrs, int defStyleAttr, int defStyleRes) {
        super(context, attrs, defStyleAttr, defStyleRes);
    }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        // If no fixed aspect ratio has been provided, simply use the default onMeasure() behavior
        if (desiredAspectRatio == 0) {
            super.onMeasure(widthMeasureSpec, heightMeasureSpec);
            return;
        }

        // Based on code from: https://www.buzzingandroid.com/2012/11/easy-measuring-of-custom-views-with-specific-aspect-ratio/
        int widthSize = MeasureSpec.getSize(widthMeasureSpec);
        int heightSize = MeasureSpec.getSize(heightMeasureSpec);

        int measuredHeight, measuredWidth;
        if (widthSize > heightSize * desiredAspectRatio) {
            measuredHeight = heightSize;
            measuredWidth = (int)(measuredHeight * desiredAspectRatio);
        } else {
            measuredWidth = widthSize;
            measuredHeight = (int)(measuredWidth / desiredAspectRatio);
        }

        setMeasuredDimension(measuredWidth, measuredHeight);
    }

    @Override
    public boolean onKeyPreIme(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && event.getAction() == KeyEvent.ACTION_DOWN && inputCallbacks != null)
            inputCallbacks.keyboardDismissed();
        // This callbacks allows us to override dumb IME behavior like when
        // Samsung's default keyboard consumes Shift+Space.
        if (inputCallbacks != null) {
            if (event.getAction() == KeyEvent.ACTION_DOWN) {
                if (inputCallbacks.handleKeyDown(event)) {
                    return true;
                }
            }
            else if (event.getAction() == KeyEvent.ACTION_UP) {
                if (inputCallbacks.handleKeyUp(event)) {
                    return true;
                }
            }
        }

        return super.onKeyPreIme(keyCode, event);
    }

    public interface InputCallbacks {
        default void keyboardDismissed() {}
        boolean handleKeyUp(KeyEvent event);
        boolean handleKeyDown(KeyEvent event);
    }

    @Override public boolean onCheckIsTextEditor() { return true; }

    @Override public InputConnection onCreateInputConnection(EditorInfo info) {
        info.inputType = InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_MULTI_LINE;
        info.imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI | EditorInfo.IME_FLAG_NO_FULLSCREEN
                | EditorInfo.IME_FLAG_NO_PERSONALIZED_LEARNING;
        info.initialSelStart = info.initialSelEnd = 0;
        // Keep composing spans in a real local editor. BaseInputConnection's
        // fallback mode also sends and clears text from setComposingRegion(),
        // turning successive speech revisions into repeated remote prefixes.
        // Use fallback mode only to translate FINAL text to the existing key /
        // Game.onKeyMultiple() transport, including single-character key events.
        BaseInputConnection committedKeys = new BaseInputConnection(this, false);
        return new BaseInputConnection(this, true) {
            // BaseInputConnection edits its buffer but does not notify the IME.
            // Without cursor/composition updates, Doubao ends every English
            // prefix before replacing it, causing repeated remote commits.
            // Report only after the outer batch, including our buffer clear.
            private int batchDepth;

            private void reportSelection() {
                if (batchDepth != 0) return;
                Editable text = getEditable();
                InputMethodManager manager = (InputMethodManager) getContext().getSystemService(Context.INPUT_METHOD_SERVICE);
                manager.updateSelection(StreamView.this, Selection.getSelectionStart(text),
                        Selection.getSelectionEnd(text), getComposingSpanStart(text), getComposingSpanEnd(text));
            }

            @Override public boolean beginBatchEdit() { batchDepth++; return true; }
            @Override public boolean endBatchEdit() {
                if (batchDepth == 0) return false;
                batchDepth--;
                reportSelection();
                return batchDepth > 0;
            }

            @Override public boolean setSelection(int start, int end) {
                boolean result = super.setSelection(start, end);
                reportSelection();
                return result;
            }

            private void forwardCommittedText() {
                if (getEditable().length() == 0) return;
                String text = getEditable().toString();
                getEditable().clear();
                committedKeys.commitText(text, 1);
            }

            @Override public boolean commitText(CharSequence text, int newCursorPosition) {
                beginBatchEdit();
                try {
                    boolean result = super.commitText(text, newCursorPosition);
                    forwardCommittedText();
                    return result;
                } finally { endBatchEdit(); }
            }

            @Override public boolean finishComposingText() {
                beginBatchEdit();
                try {
                    boolean result = super.finishComposingText();
                    forwardCommittedText();
                    return result;
                } finally { endBatchEdit(); }
            }

            @Override public boolean deleteSurroundingText(int before, int after) {
                // Keep composition edits local. Once committed, there is no
                // local text buffer, so IME deletion must become remote keys.
                if (getEditable().length() > 0) return super.deleteSurroundingText(before, after);
                if (before < 0 || after < 0 || before + (long)after > 100) return false;
                for (int i = 0; i < before; i++) {
                    sendKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_DEL));
                    sendKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_DEL));
                }
                for (int i = 0; i < after; i++) {
                    sendKeyEvent(new KeyEvent(KeyEvent.ACTION_DOWN, KeyEvent.KEYCODE_FORWARD_DEL));
                    sendKeyEvent(new KeyEvent(KeyEvent.ACTION_UP, KeyEvent.KEYCODE_FORWARD_DEL));
                }
                return true;
            }
            @Override public boolean deleteSurroundingTextInCodePoints(int before, int after) {
                if (getEditable().length() > 0) return super.deleteSurroundingTextInCodePoints(before, after);
                return deleteSurroundingText(before, after);
            }
        };
    }
}
