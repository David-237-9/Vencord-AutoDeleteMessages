import { definePluginSettings } from "@api/Settings";
import { OptionType } from "@utils/types";

export const MAX_SECONDS = Math.floor(2 ** 31 / 1000) - 1;

const validDelay = (value: number) =>
    value >= 0 && value <= MAX_SECONDS
    || `Enter a number between 0 and ${MAX_SECONDS} seconds.`;

export default definePluginSettings({
    dmSeconds: {
        type: OptionType.NUMBER,
        description: "Seconds before deleting your new one-to-one DM messages. 0 disables timed deletion. Pending deadlines survive a restart.",
        default: 300
    },
    groupDmSeconds: {
        type: OptionType.NUMBER,
        description: "Seconds before deleting your new group DM messages. 0 disables timed deletion. Pending deadlines survive a restart.",
        default: 300
    },
    guildSeconds: {
        type: OptionType.NUMBER,
        description: "Seconds before deleting your new server and thread messages. 0 disables timed deletion. Pending deadlines survive a restart.",
        default: 300
    },
    dmOnClose: {
        type: OptionType.BOOLEAN,
        description: "Delete your tracked DM messages when the client closes or reloads, independently of the timer.",
        default: false
    },
    groupDmOnClose: {
        type: OptionType.BOOLEAN,
        description: "Delete your tracked group DM messages when the client closes or reloads, independently of the timer.",
        default: false
    },
    guildOnClose: {
        type: OptionType.BOOLEAN,
        description: "Delete your tracked server messages when the client closes or reloads, independently of the timer.",
        default: false
    }
}, {
    dmSeconds: { isValid: validDelay },
    groupDmSeconds: { isValid: validDelay },
    guildSeconds: { isValid: validDelay }
});
