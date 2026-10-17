package com.limelight.ui;

import android.app.*;
import android.content.SharedPreferences;
import android.text.InputFilter;
import android.view.*;
import android.widget.*;
import com.limelight.R;
import org.json.JSONException;
import java.util.*;
import java.util.function.BooleanSupplier;

/** Explicit user-created chords shared by remote computers on this phone. */
final class CustomShortcutPanel {
    private final Activity activity;
    private final DesktopInput input;
    private final BooleanSupplier ready;
    private final Runnable release;
    private final SharedPreferences storage;
    private AlertDialog dialog;
    CustomShortcutPanel(Activity activity,DesktopInput input,BooleanSupplier ready,Runnable release){
        this.activity=activity;this.input=input;this.ready=ready;this.release=release;
        storage=activity.getSharedPreferences("desktop_shortcuts",0);
    }
    void close(){if(dialog!=null){dialog.dismiss();dialog=null;}}
    private boolean usable(){return !activity.isFinishing() && !activity.isDestroyed() && ready.getAsBoolean();}
    void show(){
        if(!usable())return;release.run();close();
        final List<CustomShortcut> values;
        try{values=CustomShortcut.decode(storage.getString("chords","{\"version\":1,\"items\":[]}"));}
        catch(JSONException|ClassCastException e){
            dialog=new AlertDialog.Builder(activity).setTitle(R.string.shortcuts_title).setMessage(R.string.shortcuts_invalid)
                    .setPositiveButton(R.string.shortcuts_reset,(d,w)->{if(storage.edit().remove("chords").commit())show();else message(R.string.shortcuts_save_failed);})
                    .setNegativeButton(android.R.string.cancel,null).show();return;
        }
        ScrollView scroll=new ScrollView(activity);LinearLayout body=new LinearLayout(activity);body.setOrientation(LinearLayout.VERTICAL);scroll.addView(body);
        if(values.isEmpty()){TextView empty=new TextView(activity);empty.setText(R.string.shortcuts_empty);empty.setPadding(24,24,24,24);body.addView(empty);}
        for(CustomShortcut value:values){
            LinearLayout row=new LinearLayout(activity);row.setBaselineAligned(false);row.setGravity(Gravity.CENTER_VERTICAL);body.addView(row);
            Button send=new Button(activity);send.setAllCaps(false);send.setText(value.name+"\n"+value.label());row.addView(send,new LinearLayout.LayoutParams(0,-2,1));
            send.setOnClickListener(v->{if(usable()){release.run();input.tap(value.chord());}});
            Button edit=new Button(activity);edit.setText(R.string.shortcuts_edit);row.addView(edit);
            edit.setOnClickListener(v->editActions(values,value));
        }
        dialog=new AlertDialog.Builder(activity).setTitle(R.string.shortcuts_title).setView(scroll)
                .setPositiveButton(R.string.shortcuts_add,(d,w)->{if(values.size()<CustomShortcut.LIMIT)editor(values,null);else message(R.string.shortcuts_limit);})
                .setNegativeButton(R.string.shortcuts_done,null).show();
    }
    private void editActions(List<CustomShortcut> values,CustomShortcut selected){
        close();dialog=new AlertDialog.Builder(activity).setTitle(selected.name).setItems(new String[]{activity.getString(R.string.shortcuts_edit),activity.getString(R.string.shortcuts_up),activity.getString(R.string.shortcuts_down),activity.getString(R.string.shortcuts_delete)},(d,index)->{
            if(!usable())return;
            if(index==0){editor(values,selected);return;}
            int at=values.indexOf(selected);
            if(index==1 && at>0)Collections.swap(values,at,at-1);
            if(index==2 && at+1<values.size())Collections.swap(values,at,at+1);
            if(index==3)values.remove(selected);
            if(save(values))show();
        }).setNegativeButton(android.R.string.cancel,(d,w)->show()).show();
    }
    private void editor(List<CustomShortcut> values,CustomShortcut original){
        if(!usable())return;close();
        LinearLayout form=new LinearLayout(activity);form.setOrientation(LinearLayout.VERTICAL);form.setPadding(24,12,24,12);
        EditText name=new EditText(activity);name.setSingleLine(true);name.setHint(R.string.shortcuts_name);name.setFilters(new InputFilter[]{new InputFilter.LengthFilter(36)});form.addView(name);
        if(original!=null)name.setText(original.name);
        LinearLayout modifiers=new LinearLayout(activity);form.addView(modifiers);CheckBox[] boxes=new CheckBox[4];String[] labels={"Shift","Ctrl","Alt","Win"};
        for(int i=0;i<4;i++){boxes[i]=new CheckBox(activity);boxes[i].setText(labels[i]);boxes[i].setChecked(original!=null && (original.modifiers&(1<<i))!=0);modifiers.addView(boxes[i]);}
        Spinner key=new Spinner(activity);List<Integer> codes=new ArrayList<>(CustomShortcut.KEYS.keySet());
        key.setAdapter(new ArrayAdapter<>(activity,android.R.layout.simple_spinner_dropdown_item,new ArrayList<>(CustomShortcut.KEYS.values())));form.addView(key);
        if(original!=null)key.setSelection(codes.indexOf(original.key));
        dialog=new AlertDialog.Builder(activity).setTitle(original==null?R.string.shortcuts_add:R.string.shortcuts_edit).setView(form)
                .setPositiveButton(R.string.shortcuts_save,null).setNegativeButton(android.R.string.cancel,(d,w)->show()).create();
        dialog.setOnShowListener(d->dialog.getButton(AlertDialog.BUTTON_POSITIVE).setOnClickListener(v->{
            if(!usable())return;int mask=0;for(int i=0;i<4;i++)if(boxes[i].isChecked())mask|=1<<i;
            try{
                CustomShortcut value=new CustomShortcut(original==null?UUID.randomUUID().toString().replace("-",""):original.id,name.getText().toString().trim(),mask,codes.get(key.getSelectedItemPosition()));
                List<CustomShortcut> changed=new ArrayList<>(values);if(original==null)changed.add(value);else changed.set(values.indexOf(original),value);
                if(save(changed))show();
            }catch(JSONException e){name.setError(activity.getString(R.string.shortcuts_name_invalid));}
        }));dialog.show();
    }
    private boolean save(List<CustomShortcut> values){
        if(!usable())return false;
        try{if(storage.edit().putString("chords",CustomShortcut.encode(values)).commit())return true;}catch(JSONException ignored){}
        message(R.string.shortcuts_save_failed);return false;
    }
    private void message(int id){Toast.makeText(activity,id,Toast.LENGTH_LONG).show();}
}
