Add-Type -AssemblyName System.Speech
$synth = New-Object System.Speech.Synthesis.SpeechSynthesizer
$voice = $synth.GetInstalledVoices() | Where-Object { $_.VoiceInfo.Culture.Name -like 'zh-*' } | Select-Object -First 1
$target = Join-Path (Split-Path -Parent $PSScriptRoot) 'artifacts/speech-test.wav'
if ($voice) {
    $synth.SelectVoice($voice.VoiceInfo.Name)
    $text = [System.Text.Encoding]::UTF8.GetString([System.Convert]::FromBase64String('5LuA5LmI5piv5pWw5o2u5bqT57Si5byV77yf5aaC5L2V5LyY5YyW5oWi5p+l6K+i77yf'))
} else { $text = 'What is a database? How does a database index work?' }
$synth.SetOutputToWaveFile($target)
$synth.Speak($text)
$synth.Dispose()
Write-Host 'Synthetic speech fixture generated.'
