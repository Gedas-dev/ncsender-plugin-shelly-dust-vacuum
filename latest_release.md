## What's Changed

### ✨ New
- First public release
- Switches a **dust extractor** and a **vacuum pump**, each through its own Shelly relay (Gen2 or newer) over the local network. No cloud, no Home Assistant
- The dust extractor follows the spindle: on at M3 / M4, off a few seconds after the machine has stopped. It can follow flood coolant, mist coolant or whole jobs instead
- The vacuum pump is switched by hand only unless you choose otherwise, so it never lets go of the work on its own
- Optional On / Off switch for each on ncSender's main screen (Auxiliary I/O), which also shows when the device runs
- A window with both relays' live state, Off | On, and a Test button for each Shelly's address

### ℹ️ Notes
- Needs ncSender 2.0.225 or newer
- Authentication must be off on the Shelly (it is off out of the box)
- For a main-screen switch, use a controller output with nothing wired to it: the plugin turns it on by itself

### 📦 Install
Download `com.community.shellydustextractor_v0.3.2.zip` below. In ncSender open Settings → Plugins → Install Plugin and choose it. Do not unzip it.
