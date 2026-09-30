# AutoDeleteMessages

AutoDeleteMessages is a Vencord plugin that deletes messages you send after a configurable delay or when you close the client.
It has separate settings for direct messages, group direct messages, and server channels.

The plugin tracks **new messages you send while it is enabled**. It does not scan or delete your existing message history.

## Settings

| Channel type | Delay setting | Delete on close setting |
| --- | --- | --- |
| One-to-one DMs | `Dm Seconds` | `Dm On Close` |
| Group DMs | `Group Dm Seconds` | `Group Dm On Close` |
| Servers and threads | `Guild Seconds` | `Guild On Close` |

- Enter a delay in seconds to delete messages after they are sent.
- Set a delay to `0` to turn off timed deletion for that channel type.
- Turn on **Delete on close** to delete its tracked messages when the client closes, even if its delay is `0`.
- All three delays default to `300`, and all three close switches default to off.

If both controls for a channel type are off, the plugin does not track messages in that type of channel.

## Installation

This is a custom plugin for a Vencord build from source.

1. Pull this repository into `src/userplugins/`.
2. Quit Discord, rebuild Vencord and inject the new build into your desktop client.
3. Enable **AutoDeleteMessages** in Vencord's plugin settings and configure the three delays and close switches.

## Notes

- The plugin does not delete messages sent before it was enabled.
- Closing the client pauses timed deletion, but it will still delete messages if the corresponding **Delete on close** option is enabled. Pending messages and their deadlines are saved for recovery on the next launch.
- On close, if the corresponding option is enabled, the plugin will hold your desktop client open to delete messages.
- Up to three deletion requests can run at once. Channels take turns, and a channel waiting for a cooldown does not block other ready channels. Discord's cooldowns can still slow deletion.
- With the corresponding **Delete on close** option enabled, switching back to an account restores its saved, tracked messages and queues them for deletion, even if the client remains open.
