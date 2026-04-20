function getTauriCore() {
	const core = window.__TAURI__?.core;
	if (!core) {
		throw new Error('Tauri bridge is not available yet.');
	}
	return core;
}

export function invoke(command, payload) {
	return getTauriCore().invoke(command, payload);
}

export class Channel {
	constructor(...args) {
		const CoreChannel = getTauriCore().Channel;
		if (typeof CoreChannel !== 'function') {
			throw new Error('Tauri Channel API is not available.');
		}
		return new CoreChannel(...args);
	}
}
