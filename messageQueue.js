class MessageQueue {
    constructor(bot) {
        this.bot = bot;
        this.queue = [];
        this.processing = false;
    }

    add(message) {
        return new Promise((resolve, reject) => {
            this.queue.push({ message, resolve, reject });
            this._processQueue();
        });
    }

    async _processQueue() {
        if (this.processing) return;
        this.processing = true;

        while (this.queue.length > 0) {
            const { message, resolve, reject } = this.queue.shift();
            try {
                let sent;
                if (message.options?.mediaPath) {
                    const media = await require('whatsapp-web.js').MessageMedia.fromFilePath(message.options.mediaPath);
                    sent = await this.bot.client.sendMessage(message.to, media, { caption: message.content, ...message.options });
                } else {
                    sent = await this.bot.client.sendMessage(message.to, message.content, message.options);
                }
                resolve(sent);
            } catch (err) {
                reject(err);
            }
        }

        this.processing = false;
    }
}

module.exports = MessageQueue;