const { proto } = require('@whiskeysockets/baileys/lib/Types');
const { initAuthCreds, BufferJSON } = require('@whiskeysockets/baileys');

module.exports = async (collection) => {
    const writeData = async (data, id) => {
        try {
            const informationToStore = JSON.parse(JSON.stringify(data, BufferJSON.replacer));
            const update = { $set: { ...informationToStore } };
            await collection.updateOne({ _id: id }, update, { upsert: true });
        } catch (err) {
            console.error('Erreur MongoDB writeData:', err.message);
        }
    };

    const readData = async (id) => {
        try {
            const data = await collection.findOne({ _id: id });
            if (data) {
                return JSON.parse(JSON.stringify(data), BufferJSON.reviver);
            }
        } catch (error) {
            console.error('Erreur MongoDB readData:', error.message);
        }
        return null;
    };

    const removeData = async (id) => {
        try {
            await collection.deleteOne({ _id: id });
        } catch (error) {
            console.error('Erreur MongoDB removeData:', error.message);
        }
    };

    const creds = await readData('creds') || initAuthCreds();

    return {
        state: {
            creds,
            keys: {
                get: async (type, ids) => {
                    const data = {};
                    await Promise.all(
                        ids.map(async (id) => {
                            let value = await readData(`${type}-${id}`);
                            if (type === 'app-state-sync-key' && value) {
                                value = proto.Message.AppStateSyncKeyData.fromObject(value);
                            }
                            data[id] = value;
                        })
                    );
                    return data;
                },
                set: async (data) => {
                    const tasks = [];
                    for (const category in data) {
                        for (const id in data[category]) {
                            const value = data[category][id];
                            const key = `${category}-${id}`;
                            tasks.push(value ? writeData(value, key) : removeData(key));
                        }
                    }
                    await Promise.all(tasks);
                }
            }
        },
        saveCreds: () => writeData(creds, 'creds')
    };
};
