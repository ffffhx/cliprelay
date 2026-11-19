package com.limelight.herdr;

import android.content.Context;
import android.content.res.Configuration;

/** Matches ClipRelay's native home screen, including the system appearance. */
final class HerdrPalette {
    final int background, surface, field, ink, muted, primary, onPrimary, selection, outline, danger;
    HerdrPalette(Context context) {
        boolean dark=(context.getResources().getConfiguration().uiMode&Configuration.UI_MODE_NIGHT_MASK)==Configuration.UI_MODE_NIGHT_YES;
        background=dark?0xff181c24:0xfff7f8fa;
        surface=dark?0xff20252f:0xffffffff;
        field=dark?0xff2a303c:0xfff1f3f7;
        ink=dark?0xffe8f1fa:0xff202633;
        muted=dark?0xffb8c8d8:0xff596474;
        primary=dark?0xff7ab7ff:0xff3f5ed7;
        onPrimary=dark?0xff002d52:0xffffffff;
        selection=dark?0xff243b5e:0xffe8eeff;
        outline=dark?0xff50677a:0xffdde2ea;
        danger=dark?0xffd94b57:0xffc73d4c;
    }
}
