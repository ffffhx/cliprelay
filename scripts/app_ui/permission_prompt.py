"""Recognize only an exact ClipRelay permission dialog in one system window."""
BROKER='com.apple.accessibility.universalAccessAuthWarn'
PATH='/System/Library/PrivateFrameworks/UniversalAccess.framework/Versions/A/Resources/universalAccessAuthWarn.app/Contents/MacOS/universalAccessAuthWarn'

def permission_prompt(brokers,permission):
    assert permission in ['screen','input']
    title='Screen Recording' if permission=='screen' else 'Accessibility Access'
    phrase=('“ClipRelay” would like to record this computer’s screen and audio.' if permission=='screen' else
            '“ClipRelay” would like to control this computer using accessibility features.')
    for broker in brokers:
        if broker.get('bundle')!=BROKER or broker.get('path')!=PATH:continue
        windows=[]
        for node in broker.get('nodes',[]):
            if node.get('role')=='AXWindow' and node.get('depth')==0:windows.append([])
            if windows:windows[-1].append(node)
        for window in windows:
            if window[0].get('title')!=title:continue
            texts=[node.get('value') for node in window if node.get('role')=='AXStaticText']
            buttons=[node.get('title') for node in window if node.get('role')=='AXButton']
            if phrase in texts and buttons.count('Open System Settings')==1 and buttons.count('Deny')==1:return True
    return False
