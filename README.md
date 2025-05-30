This is a video server and a Roku App

To set up server please run the following
- `git clone https://github.com/mythius/videostream`
- `npm install`

Run server as background process. If you want help see https://github.com/mythius/scripts to create a service file.


Update your URL in server.js and rokuapp/components/MainScene.brs, re zip all contents rokuapp, and this is your roku app zip to upload to your roku device.

See https://developer.roku.com/docs/developer-program/getting-started/developer-setup.md
for instructions to set up your own roku app.

If you are starting your own DVD mp4 collection I strongly recommend 
- MakeMKV https://www.makemkv.com/
- ffmpeg `winget install ffmpeg` (windows) `sudo apt install ffmpeg` (linux)