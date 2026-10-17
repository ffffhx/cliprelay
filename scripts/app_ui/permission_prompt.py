"""Recognize only an exact ClipRelay permission dialog in one system window."""
BROKER='com.apple.accessibility.universalAccessAuthWarn'
PATH='/System/Library/PrivateFrameworks/UniversalAccess.framework/Versions/A/Resources/universalAccessAuthWarn.app/Contents/MacOS/universalAccessAuthWarn'

def windows(nodes):
    result=[]
    for node in nodes:
        if node.get('role')=='AXWindow' and node.get('depth')==0:result.append([])
        if result:result[-1].append(node)
    return result

def settings_window(brokers,permission):
    assert permission in ['screen','input']
    title='Screen & System Audio Recording' if permission=='screen' else 'Accessibility'
    for broker in brokers:
        if broker.get('bundle')!='com.apple.systempreferences' or broker.get('path')!='/System/Applications/System Settings.app/Contents/MacOS/System Settings':continue
        for window in windows(broker.get('nodes',[])):
            if window[0].get('title')==title and any(node.get('role')=='AXStaticText' and node.get('value')=='ClipRelay' for node in window):return True
    return False

def permission_prompt(brokers,permission):
    assert permission in ['screen','input']
    title='Screen Recording' if permission=='screen' else 'Accessibility Access'
    phrase=('“ClipRelay” would like to record this computer’s screen and audio.' if permission=='screen' else
            '“ClipRelay” would like to control this computer using accessibility features.')
    for broker in brokers:
        if broker.get('bundle')!=BROKER or broker.get('path')!=PATH:continue
        for window in windows(broker.get('nodes',[])):
            if window[0].get('title')!=title:continue
            texts=[node.get('value') for node in window if node.get('role')=='AXStaticText']
            buttons=[node.get('title') for node in window if node.get('role')=='AXButton']
            if phrase in texts and buttons.count('Open System Settings')==1 and buttons.count('Deny')==1:return True
    return False
