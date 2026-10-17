import unittest
from permission_prompt import BROKER,PATH,permission_prompt,settings_window

def screen_nodes():
    return [{'role':'AXWindow','depth':0,'title':'Screen Recording'},
            {'role':'AXStaticText','depth':1,'value':'“ClipRelay” would like to record this computer’s screen and audio.'},
            {'role':'AXButton','depth':1,'title':'Open System Settings'},
            {'role':'AXButton','depth':1,'title':'Deny'}]

def broker(nodes):return {'bundle':BROKER,'path':PATH,'nodes':nodes}

class PermissionPromptTest(unittest.TestCase):
    def test_captured_local_network_prompt_and_empty_accessibility_broker_are_not_input_consent(self):
        observed=[broker([]),{'bundle':'com.apple.UserNotificationCenter','path':'/System/Library/CoreServices/UserNotificationCenter.app/Contents/MacOS/UserNotificationCenter',
            'nodes':[{'role':'AXWindow','depth':0,'description':'alert'},
                     {'role':'AXStaticText','depth':1,'value':'Allow “ClipRelay” to find devices on local networks?'},
                     {'role':'AXButton','depth':1,'title':'Allow'},
                     {'role':'AXButton','depth':1,'title':'Don’t Allow'}]}]
        self.assertFalse(permission_prompt(observed,'input'))
        self.assertFalse(permission_prompt(observed,'screen'))

    def test_captured_screen_prompt_matches_only_screen(self):
        observed=[broker(screen_nodes())]
        self.assertTrue(permission_prompt(observed,'screen'))
        self.assertFalse(permission_prompt(observed,'input'))

    def test_do_not_combine_two_windows_or_accept_another_app(self):
        nodes=screen_nodes();nodes.insert(2,{'role':'AXWindow','depth':0,'title':'Other'})
        self.assertFalse(permission_prompt([broker(nodes)],'screen'))
        nodes=screen_nodes();nodes[1]['value']=nodes[1]['value'].replace('ClipRelay','OtherApp')
        self.assertFalse(permission_prompt([broker(nodes)],'screen'))

    def test_same_text_from_other_process_is_not_a_system_prompt(self):
        item=broker(screen_nodes());item['path']='/tmp/universalAccessAuthWarn'
        self.assertFalse(permission_prompt([item],'screen'))

    def test_sidebar_accessibility_text_does_not_turn_screen_settings_into_input_settings(self):
        item={'bundle':'com.apple.systempreferences','path':'/System/Applications/System Settings.app/Contents/MacOS/System Settings',
              'nodes':[{'role':'AXWindow','depth':0,'title':'Screen & System Audio Recording'},
                       {'role':'AXStaticText','depth':8,'value':'Accessibility'},
                       {'role':'AXStaticText','depth':11,'value':'ClipRelay'}]}
        self.assertTrue(settings_window([item],'screen'))
        self.assertFalse(settings_window([item],'input'))

    def test_settings_title_and_app_name_must_belong_to_same_window(self):
        item={'bundle':'com.apple.systempreferences','path':'/System/Applications/System Settings.app/Contents/MacOS/System Settings',
              'nodes':[{'role':'AXWindow','depth':0,'title':'Accessibility'},
                       {'role':'AXWindow','depth':0,'title':'Screen & System Audio Recording'},
                       {'role':'AXStaticText','depth':11,'value':'ClipRelay'}]}
        self.assertFalse(settings_window([item],'input'))

if __name__=='__main__':unittest.main()
