# Run the netplay soak test against a live relay to validate the adaptive
# input-delay probe + lockstep handshake end-to-end.
$env:PORT = "3199"
$relay = Start-Process node -ArgumentList "relay.js" -PassThru -NoNewWindow
Start-Sleep -Seconds 2
try {
  node test_real_soak.js
} finally {
  Stop-Process -Id $relay.Id -Force -ErrorAction SilentlyContinue
}
