import { EmbedBuilder } from 'discord.js';
import { truncate } from '../mail/format.js';

/** Posts log messages to the log channel chosen with /setup (if any). */
export function createAudit({ client, store, log }) {
  return (text) => {
    const channelId = store.getSetting('log_channel_id');
    if (!channelId || !client.isReady()) return;
    client.channels.fetch(channelId)
      .then((channel) => {
        if (!channel?.isTextBased()) return null;
        return channel.send({
          embeds: [new EmbedBuilder().setColor(0x99aab5).setDescription(truncate(text, 4096)).setTimestamp()],
          allowedMentions: { parse: [] },
        });
      })
      .catch((err) => log.warn(`Log channel unreachable: ${err.message}`));
  };
}
