Set shell = CreateObject("WScript.Shell")
Set fileSystem = CreateObject("Scripting.FileSystemObject")

If WScript.Arguments.Count = 0 Then
    MsgBox "Pass the full path to DeepSeek Harness.exe as the first argument.", vbExclamation, "DS Bot Direct"
    WScript.Quit 2
End If

powerShellPath = shell.ExpandEnvironmentStrings("%SystemRoot%") & "\System32\WindowsPowerShell\v1.0\powershell.exe"
scriptDirectory = fileSystem.GetParentFolderName(WScript.ScriptFullName)
launcherPath = fileSystem.BuildPath(scriptDirectory, "Start-DS-Bot-Direct.ps1")
applicationPath = WScript.Arguments(0)
If InStr(applicationPath, Chr(34)) > 0 Then
    MsgBox "The application path cannot contain a double-quote character.", vbExclamation, "DS Bot Direct"
    WScript.Quit 2
End If
commandLine = QuoteCommandArgument(powerShellPath) & " -NoProfile -ExecutionPolicy Bypass -File " & QuoteCommandArgument(launcherPath) & " -ApplicationPath " & QuoteCommandArgument(applicationPath)
shell.Run commandLine, 0, False

Function QuoteCommandArgument(value)
    QuoteCommandArgument = Chr(34) & value & Chr(34)
End Function
