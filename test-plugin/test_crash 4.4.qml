import QtQuick
import QtQuick.Layouts
import QtQuick.Controls

import MuseScore
import Muse.UiComponents

MuseScore {
  version: "0.1"
  title: "Hello world";
  description: "v0.1 for MuseScore 4.4+"
//   thumbnailName: "DrumSetPatternsIcon.png";
//   pluginType: "dialog"

//=============================================================================

  MessageDialog
  {
    id: versionError
    visible: false
    title: qsTr("Unsupported MuseScore Version")
    text: qsTr("This plugin is for MuseScore 4.4 or later")
    onAccepted: {
      (typeof(quit) === 'undefined' ? Qt.quit : quit)()
    }
  }


//=============================================================================

  function showMessage(message)
  {
    infoDialog.text = message;
    infoDialog.open();
  }

  MessageDialog
  {
    id: infoDialog
    visible: false
    title: "Hello world"
    text: "someTextHere"
    onAccepted: {
      close();
    }
  }




  function arrayContains(arr, val)
  {
    for (var a in arr)
    {
      if (arr[a] === val) return true;
    }
    return false;
  }


  function initialiseScoreChanges()
  {
    curScore.startCmd();
  }

  function finaliseScoreChanges()
  {
    curScore.endCmd()
  }

  function _quit() {
      (typeof(quit) === 'undefined' ? Qt.quit : quit)()
  }

  onRun:
  {

    if ((mscoreMajorVersion <= 3) || ((mscoreMajorVersion == 4 && mscoreMinorVersion < 4 )))
    {
      versionError.open()
      _quit();
      return;
    }

    showMessage("Hello world");

    _quit();

  }

}