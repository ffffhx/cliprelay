package com.limelight.grid;

import android.content.Context;
import android.view.View;
import android.widget.ImageView;
import android.widget.ProgressBar;
import android.widget.TextView;

import com.limelight.PcView;
import com.limelight.R;
import com.limelight.nvstream.http.ComputerDetails;
import com.limelight.nvstream.http.PairingManager;
import com.limelight.preferences.PreferenceConfiguration;

import java.util.Collections;
import java.util.Comparator;

public class PcGridAdapter extends GenericGridAdapter<PcView.ComputerObject> {

    public PcGridAdapter(Context context, PreferenceConfiguration prefs) {
        super(context, getLayoutIdForPreferences(prefs));
    }

    private static int getLayoutIdForPreferences(PreferenceConfiguration prefs) {
        return R.layout.pc_grid_item;
    }

    public void updateLayoutWithPreferences(Context context, PreferenceConfiguration prefs) {
        // This will trigger the view to reload with the new layout
        setLayoutId(getLayoutIdForPreferences(prefs));
    }

    public void addComputer(PcView.ComputerObject computer) {
        itemList.add(computer);
        sortList();
    }

    private void sortList() {
        Collections.sort(itemList, new Comparator<PcView.ComputerObject>() {
            @Override
            public int compare(PcView.ComputerObject lhs, PcView.ComputerObject rhs) {
                return lhs.details.name.toLowerCase().compareTo(rhs.details.name.toLowerCase());
            }
        });
    }

    public boolean removeComputer(PcView.ComputerObject computer) {
        return itemList.remove(computer);
    }

    @Override
    public void populateView(View parentView, ImageView imgView, ProgressBar prgView, TextView txtView, ImageView overlayView, PcView.ComputerObject obj) {
        ComputerDetails details = obj.details;
        boolean online = details.state == ComputerDetails.State.ONLINE;
        boolean paired = details.pairState == PairingManager.PairState.PAIRED;
        boolean checking = details.state == ComputerDetails.State.UNKNOWN;
        imgView.setImageResource(R.drawable.remote_ic_monitor);
        imgView.setAlpha(online ? 1.0f : 0.55f);
        txtView.setText(com.limelight.ui.RemoteUi.computerName(details.name));
        prgView.setVisibility(checking ? View.VISIBLE : View.GONE);
        overlayView.setVisibility(View.GONE);

        TextView status = parentView.findViewById(R.id.remotePcStatus);
        status.setText(checking ? R.string.remote_checking : !online ? R.string.remote_offline :
                paired ? R.string.remote_online_paired : R.string.remote_online_unpaired);
        status.setTextColor(context.getColor(online ? R.color.remote_success : R.color.remote_muted));
        status.setBackgroundTintList(android.content.res.ColorStateList.valueOf(
                context.getColor(online ? R.color.remote_success_background : R.color.remote_tint)));

        ComputerDetails.AddressTuple address = details.activeAddress != null ? details.activeAddress :
                details.manualAddress != null ? details.manualAddress :
                details.localAddress != null ? details.localAddress : details.remoteAddress;
        TextView addressView = parentView.findViewById(R.id.remotePcAddress);
        addressView.setText(!online ? context.getString(R.string.remote_auto_connect) :
                com.limelight.computers.EmbeddedNetwork.isAddress(address) ? context.getString(R.string.remote_route_embedded) :
                context.getString(R.string.remote_route_direct, address == null ? "" : address.toString()));

        TextView action = parentView.findViewById(R.id.remotePcAction);
        action.setText(!online ? R.string.remote_check_connection :
                paired ? R.string.remote_open_computer : R.string.remote_pair_computer);
        View more = parentView.findViewById(R.id.remotePcMore);
        more.setContentDescription(context.getString(R.string.remote_more, details.name));
        more.setOnClickListener(v -> parentView.showContextMenu());
    }
}
