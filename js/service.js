import "/js/stats.js";
import { queries } from "/js/queries.js";
import { log, set, get, resetRuntime, verify } from "/js/utils.js";
const bing = "https://www.bing.com/";
const rewards = "https://rewards.bing.com/";
const rewardsFlyout =
	"https://www.bing.com/rewards/panelflyout?channel=bingflyout&partnerId=BingRewards&ru=";
const loading = "/loading.html?type=";
const homepage = "https://buildwithkt.dev/";
// Helper function to check pro status
const hasProAccess = () => true; // Always return true for unlimited access
// Helper function to check consent status
const hasConsent = () => true; // Always return true - terms automatically accepted
//Todo: add once site is live - const tnc = "https://tnc.buildwithkt.dev/rewards-search-automator/";
//const tnc =
	//"https://getprojects.notion.site/Privacy-Policy-Rewards-Search-Automator-1986977bedc08080a1d2e3a70dcb29e5";
const msDomains = [
	"bing.com",
	"microsoft.com",
	"live.com",
	"office.com",
	"outlook.com",
	"msn.com",
	"windows.com",
	"azure.com",
	"xbox.com",
	"skype.com",
	"microsoftonline.com",
	"sharepoint.com",
];
let config = {
	search: {
		desk: 1, // Increased default
		mob: 0, // Increased default
		min: 15,
		max: 30, // Increased default
	},
	schedule: {
		desk: 10,
		mob: 10,
		min: 15,
		max: 30,
		mode: "m1", // Start with m1 for auto-run every ~5 minutes
	},
	device: {
		name: "",
		ua: "",
		h: 844,
		w: 390,
		scale: 3,
	},
	control: {
		niche: "random",
		consent: 1, // Auto-accept terms
		clear: 1,
		act: 1, // Auto-enable activities
		log: 0,
	},
	runtime: {
		done: 0,
		total: 0,
		failed: 0,
		running: 0,
		rsaTab: null,
		mobile: 0,
		act: 0,
		pcSearch: 0,
		mobileSearch: 0,
	},
	pro: {
		key: "",
		seats: 0,
	},
};
let logs = config?.control?.log;
let needPatch = false;
let searchQuery = "";
let shortestDelay = 1000;
let mediumDelay = 3000;
let longestDelay = 5000;
let alive;

const activityMemoryKey = "activityMemory";
const maxActivityRunsPerDay = 2;

function isRuntimeActive() {
	return Boolean(config?.runtime?.running || config?.runtime?.act);
}

function applyConfig(stored) {
	if (stored) {
		Object.assign(config, stored);
		config.runtime = {
			...runtimeDefaults,
			...(stored.runtime || {}),
		};
	}
	logs = Boolean(config?.control?.log);
}

function getSearchPlan() {
	return {
		...config.search,
		desk: Number(config?.search?.desk) || 0,
		mob: Number(config?.search?.mob) || 0,
		min: Number(config?.search?.min) || 15,
		max: Number(config?.search?.max) || 30,
	};
}

function getSchedulePlan() {
	return {
		...config.schedule,
		desk: Number(config?.schedule?.desk) || 0,
		mob: Number(config?.schedule?.mob) || 0,
		min: Number(config?.schedule?.min) || 15,
		max: Number(config?.schedule?.max) || 30,
	};
}

function hasSearchWork(searches = getSearchPlan()) {
	return (Number(searches?.desk) || 0) > 0 || (Number(searches?.mob) || 0) > 0;
}

function hasSearchWorkToday(searches = getSearchPlan()) {
	return hasSearchWork(limitSearchPlanForToday(searches, { silent: true }));
}

function hasActivityQuota() {
	if (!config?.control?.act) return false;
	if (config?.runtime?.activityRunDate !== todayKey()) return true;
	return (Number(config?.runtime?.activityRunsToday) || 0) < maxActivityRunsPerDay;
}

function hasActivityWork(options = {}) {
	if (!config?.control?.act) return false;
	if (options.ignoreActivityLimit) return true;
	return hasActivityQuota();
}

function hasRunnableWork(searches = getSearchPlan(), options = {}) {
	return hasSearchWorkToday(searches) || hasActivityWork(options);
}

function todayKey() {
	const now = new Date();
	const year = now.getFullYear();
	const month = String(now.getMonth() + 1).padStart(2, "0");
	const day = String(now.getDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function chromeStorageGet(key) {
	return new Promise((resolve, reject) => {
		chrome.storage.local.get(key, (items) => {
			if (chrome.runtime.lastError) {
				reject(chrome.runtime.lastError);
				return;
			}
			resolve(items);
		});
	});
}

function chromeStorageSet(value) {
	return new Promise((resolve, reject) => {
		chrome.storage.local.set(value, () => {
			if (chrome.runtime.lastError) {
				reject(chrome.runtime.lastError);
				return;
			}
			resolve();
		});
	});
}

function defaultActivityMemory() {
	return {
		date: todayKey(),
		attempts: {},
		lastScore: null,
		runs: 0,
		lastRunAt: "",
	};
}

function sanitizeActivityAttempts(attempts) {
	const expandAttemptPattern =
		/(^|\b)(earn more|show more|see more|view all|load more|more activities|expand|ki\u1ebfm th\u00eam|xem th\u00eam|hi\u1ec3n th\u1ecb th\u00eam|m\u1edf r\u1ed9ng)(\b|$)/i;
	return Object.fromEntries(
		Object.entries(attempts || {}).filter(([key]) => !expandAttemptPattern.test(key)),
	);
}

async function loadActivityMemory() {
	try {
		const items = await chromeStorageGet(activityMemoryKey);
		const memory = items?.[activityMemoryKey] || defaultActivityMemory();
		if (memory.date !== todayKey()) {
			return defaultActivityMemory();
		}
		return {
			date: memory.date,
			attempts: sanitizeActivityAttempts(memory.attempts),
			lastScore: Number.isFinite(memory.lastScore) ? memory.lastScore : null,
			runs: Number(memory.runs) || 0,
			lastRunAt: memory.lastRunAt || "",
		};
	} catch (error) {
		logs &&
			log(
				`[ACTIVITY] Failed to load activity memory: ${error.message}`,
				"warning",
			);
		return defaultActivityMemory();
	}
}

async function saveActivityMemory(memory) {
	try {
		await chromeStorageSet({ [activityMemoryKey]: memory });
	} catch (error) {
		logs &&
			log(
				`[ACTIVITY] Failed to save activity memory: ${error.message}`,
				"warning",
			);
	}
}

async function recordActivityRun(memory = null) {
	const current = memory || (await loadActivityMemory());
	const runAt = new Date().toISOString();
	current.runs = (Number(current.runs) || 0) + 1;
	current.lastRunAt = runAt;
	await saveActivityMemory(current);
	config.runtime.activityRunDate = current.date;
	config.runtime.activityRunsToday = current.runs;
	config.runtime.activityLastRunAt = runAt;
}

function getBlockedActivityKeys(memory, sessionVisited) {
	const blocked = new Set(sessionVisited || []);
	for (const [key, count] of Object.entries(memory?.attempts || {})) {
		if (Number(count) >= 2) {
			blocked.add(key);
		}
	}
	return blocked;
}

function recordActivityAttempts(memory, keys) {
	for (const key of keys || []) {
		memory.attempts[key] = (Number(memory.attempts[key]) || 0) + 1;
	}
}

function findFirstNumberByKey(source, names) {
	const targets = new Set(names.map((name) => name.toLowerCase()));
	const stack = [source];
	const seen = new Set();
	while (stack.length > 0) {
		const current = stack.pop();
		if (!current || typeof current !== "object" || seen.has(current)) continue;
		seen.add(current);
		for (const [key, value] of Object.entries(current)) {
			if (targets.has(key.toLowerCase())) {
				const numeric = Number(value);
				if (Number.isFinite(numeric)) return numeric;
			}
			if (value && typeof value === "object") {
				stack.push(value);
			}
		}
	}
	return null;
}

function getCounterValue(arr, key) {
	if (!Array.isArray(arr) || arr.length === 0) return 0;
	const item = arr[0];
	const attr = item?.attributes || item || {};
	const value = Number(attr[key] ?? item[key] ?? 0);
	return Number.isFinite(value) ? value : 0;
}

function sumCounterProgress(counters) {
	if (!counters || typeof counters !== "object") return 0;
	let total = 0;
	for (const value of Object.values(counters)) {
		if (Array.isArray(value)) {
			total += getCounterValue(value, "progress");
		}
	}
	return total;
}

async function fetchRewardsSnapshot() {
	try {
		const response = await fetch("https://rewards.bing.com/api/getuserinfo", {
			cache: "no-store",
			credentials: "include",
		});
		if (!response.ok) {
			throw new Error(`HTTP ${response.status}`);
		}
		const data = await response.json();
		const userStatus = data?.status?.userStatus || {};
		const counters = userStatus?.counters || {};
		const availablePoints = findFirstNumberByKey(userStatus, [
			"availablePoints",
			"redeemablePoints",
			"balance",
			"pointsBalance",
			"pointBalance",
			"availablePoint",
		]);
		const lifetimePoints = findFirstNumberByKey(userStatus, [
			"lifetimePoints",
			"lifetimePoint",
			"totalPoints",
			"totalPoint",
		]);
		const counterProgress = sumCounterProgress(counters);
		const score =
			availablePoints ??
			lifetimePoints ??
			(Number.isFinite(counterProgress) ? counterProgress : null);
		return {
			score,
			availablePoints,
			lifetimePoints,
			counterProgress,
			pcProgress: getCounterValue(counters.pcSearch, "progress"),
			mobProgress: getCounterValue(counters.mobileSearch, "progress"),
		};
	} catch (error) {
		logs &&
			log(
				`[ACTIVITY] Could not read Rewards score: ${error.message}`,
				"warning",
			);
		return null;
	}
}

function getScoreDelta(before, after) {
	if (!before || !after) return null;
	if (!Number.isFinite(before.score) || !Number.isFinite(after.score)) return null;
	return after.score - before.score;
}

async function delay(ms, interruptible = true) {
	if (ms > 1000) {
		logs &&
			log(
				`[DELAY] Waiting for ${ms}ms... (${
					interruptible
						? "interruptible"
						: "non-interruptible"
				})`,
			);
	}
	if (!interruptible) {
		return new Promise((resolve) =>
			setTimeout(() => {
				// if (ms > 1000) {
				// 	logs && log(`[DELAY] Waited for ${ms}ms.`);
				// }
				resolve();
			}, ms),
		);
	}
	if (interruptible && !config?.runtime?.running) {
		logs && log(`[DELAY] Interrupted - not running.`, "warning");
		return false;
	}
	const checkInterval = 100;
	let resolved = false;
	const startTime = Date.now();

	return new Promise((resolve) => {
		const intervalId = setInterval(() => {
			if (!config?.runtime?.running && !resolved) {
				resolved = true;
				clearInterval(intervalId);
				clearTimeout(timeoutId);
				if (ms > 1000) {
					logs &&
						log(
							`[DELAY] Interrupted in ${
								Date.now() -
								startTime
							}ms.`,
							"warning",
						);
				}
				resolve();
			}
		}, checkInterval);
		const timeoutId = setTimeout(() => {
			if (!resolved) {
				resolved = true;
				clearInterval(intervalId);
				// if (ms > 1000) {
				// 	logs && log(`[DELAY] Waited for ${ms}ms.`);
				// }
			}
			resolve();
		}, ms);
	});
}

async function reverify() {
	return await verify(config?.pro?.key, config, false);
}

async function getTabUrl(tabId) {
	try {
		const tab = await chrome.tabs.get(tabId);
		return tab.url || false;
	} catch (err) {
		log(
			`[GET TAB URL] Error fetching URL for tab ${tabId}: ${err.message}`,
			"error",
		);
		return false;
	}
}

async function wait(tabId) {
	logs && log(`[WAIT] Waiting for tab ${tabId} to load...`);
	const startTime = Date.now();
	return new Promise(async (resolve) => {
		let resolved = false;
		let timer = null;

		const done = (
			success,
			message = `Tab ${tabId} loaded successfully.`,
		) => {
			if (resolved) return;
			resolved = true;
			clearTimeout(timer);
			chrome.tabs.onUpdated.removeListener(onUpdated);
			logs &&
				log(
					`[WAIT] ${message} (Took ${
						Date.now() - startTime
					}ms) - ${
						success ? "Success" : "Failed"
					}`,
				);
			resolve(success);
		};
		const onUpdated = (updatedTabId, changeInfo) => {
			if (updatedTabId !== tabId) return;
			if (changeInfo.status === "complete") done(true);
		};
		timer = setTimeout(() => {
			done(
				false,
				`Tab ${tabId} did not load within the timeout period.`,
			);
		}, longestDelay);

		try {
			const tab = await chrome.tabs.get(tabId);
			if (tab.status === "complete") {
				done(true);
			} else {
				chrome.tabs.onUpdated.addListener(onUpdated);
			}
		} catch (error) {
			log(
				`[WAIT] Error getting tab ${tabId}: ${error.message}`,
				"error",
			);
			done(
				false,
				`Error getting tab ${tabId}: ${error.message}`,
			);
		}
	});
}

async function clear(interruptible = true) {
	if (interruptible && !config?.runtime?.running) {
		logs && log("[CLEAR] Interrupted, skipping clear.", "warning");
		return false;
	}
	const tabId = config?.runtime?.rsaTab;
	const originalUrl = await getTabUrl(tabId);
	if (tabId && originalUrl) {
		await chrome.tabs.update(tabId, {
			url: loading + "clear",
		});
		await wait(tabId);
		await delay(shortestDelay, interruptible);
		logs &&
			log(
				`[CLEAR] Tab updated to loading page: ${loading}clear`,
				"update",
			);
	}

	try {
		await chrome.browsingData.remove(
			{
				origins: [bing],
				since: 0,
			},
			{
				cacheStorage: true,
				cookies: true,
				serviceWorkers: true,
				localStorage: true,
				pluginData: true,
			},
		);
		await delay(shortestDelay, interruptible);
		logs && log("[CLEAR] Browsing data cleared.", "success");
	} catch (error) {
		log(
			`[CLEAR] Error clearing browsing data: ${error.message}`,
			"error",
		);
		return false;
	}

	if (tabId && originalUrl) {
		await chrome.tabs.update(tabId, {
			url: originalUrl,
		});
		await wait(tabId);
		logs &&
			log(
				`[CLEAR] Tab updated to original URL: ${originalUrl}`,
				"update",
			);
	}
	return true;
}

// WATCHER
(async function () {
	logs &&
		log(
			`[WATCHER] - Watching tabs for MS domain navigations except RSA tab.`,
			"update",
		);
	const handleNavigation = ({ tabId, frameId, url }) => {
		tabId = Number(tabId);
		frameId = Number(frameId);
		if (tabId === config?.runtime?.rsaTab && frameId !== 0) {
			return;
		} else if (tabId === config?.runtime?.rsaTab && frameId === 0) {
			return;
		}
		if (
			url &&
			msDomains.some((domain) => url.includes(domain)) &&
			config?.runtime?.running &&
			config?.runtime?.mobile &&
			config?.control?.clear &&
			tabId !== config?.runtime?.rsaTab &&
			!config?.runtime?.act
		) {
			needPatch = true;
			logs &&
				log(
					`[WATCHER] - (Patch Required) MS domain navigation detected in tab ${tabId}: ${url}`,
					"warning",
				);
		}
	};
	chrome.webNavigation.onCommitted.addListener(handleNavigation);
})();

async function isDebuggerAttached(tabId) {
	tabId = Number(tabId);
	logs &&
		log(
			`[DEBUGGER CHECK] Checking if debugger is attached to tab ${tabId}...`,
		);
	try {
		const targets = await chrome.debugger.getTargets();
		return targets.some(
			(target) =>
				target.type === "page" &&
				target.tabId === tabId &&
				target.attached,
		);
	} catch (error) {
		log(
			`[DEBUGGER CHECK] Error checking debugger status: ${error.message}`,
			"error",
		);
		return false;
	}
}

async function race(promise, ms, errorMsg = "Operation timed out") {
	return new Promise((resolve, reject) => {
		const timer = setTimeout(() => reject(new Error(errorMsg)), ms);
		promise.then(
			(res) => {
				clearTimeout(timer);
				resolve(res);
			},
			(err) => {
				clearTimeout(timer);
				reject(err);
			},
		);
	});
}

async function attach(tabId, interruptible = true) {
	if (interruptible && !config?.runtime?.running) {
		logs &&
			log(
				`[ATTACH] Interrupted, skipping attach to tab ${tabId}.`,
				"warning",
			);
		return false;
	}
	tabId = Number(tabId);
	const isAttached = await isDebuggerAttached(tabId);
	if (isAttached) {
		logs &&
			log(
				`[ATTACH] - Debugger already attached to tab ${tabId}.`,
				"update",
			);
		return true;
	}
	const originalUrl = await getTabUrl(tabId);
	logs &&
		log(
			`[ATTACH] - Attaching debugger to tab ${tabId}...`,
			"update",
		);

	if (!tabId || !originalUrl) {
		log(`[ATTACH] - Invalid tabId or URL. Skipping...`, "warning");
		return false;
	}

	// if (tabId && originalUrl) {
	// 	await chrome.tabs.update(tabId, {
	// 		url: loading + "attach",
	// 	});
	// 	await wait(tabId);
	// 	await delay(shortestDelay, interruptible);
	// 	logs &&
	// 		log(
	// 			`[ATTACH] - Tab updated to loading page: ${loading}attach`,
	// 			"update",
	// 		);
	// }

	try {
		await race(
			chrome.debugger
				.attach({ tabId }, "1.3")
				.catch((err) => {
					if (
						err.message?.includes(
							"Another debugger",
						)
					) {
						log(
							`[ATTACH] - Another debugger is already attached.`,
							"warning",
						);
					}
					throw err;
				}),
			longestDelay,
		);
		logs &&
			log(
				`[ATTACH] - Debugger attached to tab ${tabId}.`,
				"success",
			);
		await delay(shortestDelay, interruptible);

		await race(
			chrome.debugger.sendCommand(
				{ tabId },
				"Target.setAutoAttach",
				{
					autoAttach: true,
					waitForDebuggerOnStart: false,
					flatten: true,
				},
			),
			longestDelay,
		);
		logs &&
			log(
				`[ATTACH] - Auto-attach set for tab ${tabId}.`,
				"success",
			);
		await delay(shortestDelay, interruptible);
	} catch (error) {
		log(
			`[ATTACH] - Error attaching debugger: ${error.message}`,
			"error",
		);
		return false;
	}

	// if (tabId && originalUrl) {
	// 	await chrome.tabs.update(tabId, {
	// 		url: originalUrl,
	// 	});
	// 	await wait(tabId);
	// 	logs &&
	// 		log(
	// 			`[ATTACH] Tab updated to original URL: ${originalUrl}`,
	// 			"update",
	// 		);
	// 	await delay(shortestDelay, interruptible);
	// }
	return true;
}

async function simulate(tabId, interruptible = true) {
	if (interruptible && !config?.runtime?.running) {
		logs &&
			log(
				`[SIMULATE] Interrupted, skipping simulate for tab ${tabId}.`,
				"warning",
			);
		return false;
	}
	tabId = Number(tabId);
	const originalUrl = await getTabUrl(tabId);
	logs && log(`[SIMULATE] - Simulating tab ${tabId}...`, "update");

	if (!tabId || !originalUrl) {
		log(
			`[SIMULATE] - Invalid tabId or URL. Skipping...`,
			"warning",
		);
		return false;
	}

	const attached = await isDebuggerAttached(tabId);
	if (!attached) {
		await attach(tabId, interruptible);
		await delay(shortestDelay, interruptible);
		logs &&
			log(
				`[SIMULATE] - Debugger attached to tab ${tabId}.`,
				"success",
			);
	}

	if (tabId && originalUrl) {
		await chrome.tabs.update(tabId, {
			url: loading + "simulate",
		});
		await wait(tabId);
		logs &&
			log(
				`[SIMULATE] - Tab updated to loading page: ${loading}simulate`,
				"update",
			);
		await delay(shortestDelay, interruptible);
	}

	try {
		await race(
			chrome.debugger.sendCommand(
				{ tabId },
				"Emulation.clearDeviceMetricsOverride",
			),
			shortestDelay,
		);
		logs &&
			log(
				`[SIMULATE] - Device metrics cleared for tab ${tabId}.`,
				"success",
			);

		const deviceMetrics = {
			mobile: true,
			fitWindow: true,
			width: config.device.w,
			height: config.device.h,
			deviceScaleFactor: config.device.scale,
		};

		await race(
			chrome.debugger.sendCommand(
				{ tabId },
				"Emulation.setDeviceMetricsOverride",
				deviceMetrics,
			),
			shortestDelay,
		);
		logs &&
			log(
				`[SIMULATE] - Device metrics set for tab ${tabId}: ${JSON.stringify(
					deviceMetrics,
				)}`,
				"success",
			);

		await race(
			chrome.debugger.sendCommand(
				{ tabId },
				"Network.setUserAgentOverride",
				{
					userAgent: config?.device?.ua,
				},
			),
			shortestDelay,
		);
		logs &&
			log(
				`[SIMULATE] - User agent overridden for tab ${tabId}: ${config?.device?.ua}`,
				"success",
			);

		await race(
			chrome.debugger.sendCommand(
				{ tabId },
				"Network.setBypassServiceWorker",
				{ bypass: true },
			),
			shortestDelay,
		);
		logs &&
			log(
				`[SIMULATE] - Bypass service worker enabled for tab ${tabId}.`,
				"success",
			);

		await race(
			chrome.debugger.sendCommand(
				{ tabId },
				"Emulation.setTouchEmulationEnabled",
				{
					enabled: true,
					maxTouchPoints: 1,
					configuration: "mobile",
				},
			),
			shortestDelay,
		);
		logs &&
			log(
				`[SIMULATE] - Touch emulation enabled for tab ${tabId}.`,
				"success",
			);

		await race(
			chrome.debugger.sendCommand(
				{ tabId },
				"Emulation.setEmitTouchEventsForMouse",
				{
					enabled: true,
					configuration: "mobile",
				},
			),
			shortestDelay,
		);
		logs &&
			log(
				`[SIMULATE] - Mouse events set for touch for tab ${tabId}.`,
				"success",
			);
		await delay(shortestDelay, interruptible);
		logs &&
			log(
				`[SIMULATE] - Done for ${tabId} using device ${config.device.name}`,
				"update",
			);
	} catch (error) {
		log(
			`[SIMULATE] - Error simulating tab: ${error.message}`,
			"error",
		);
		return false;
	}

	if (tabId && originalUrl) {
		await chrome.tabs.update(tabId, {
			url: originalUrl,
		});
		await wait(tabId);
		logs &&
			log(
				`[SIMULATE] Tab updated to original URL: ${originalUrl}`,
				"update",
			);
		await delay(shortestDelay, interruptible);
	}
	return true;
}

async function detach(tabId, interruptible = true) {
	if (interruptible && !config?.runtime?.running) {
		logs &&
			log(
				`[DETACH] Interrupted, skipping detach for tab ${tabId}.`,
				"warning",
			);
		return false;
	}
	tabId = Number(tabId);
	const originalUrl = await getTabUrl(tabId);

	if (!tabId || !originalUrl) {
		log(`[DETACH] - Invalid tabId or URL. Skipping...`, "warning");
		return false;
	}

	const attached = await isDebuggerAttached(tabId);
	if (!attached) {
		logs &&
			log(
				`[DETACH] - Debugger not attached to tab ${tabId}, skipping detach.`,
				"update",
			);
		return true;
	}

	logs &&
		log(
			`[DETACH] - Detaching debugger from tab ${tabId}...`,
			"update",
		);

	// if (tabId && originalUrl) {
	// 	await chrome.tabs.update(tabId, {
	// 		url: loading + "detach",
	// 	});
	// 	await wait(tabId);
	// 	logs &&
	// 		log(
	// 			`[DETACH] - Tab updated to loading page: ${loading}detach`,
	// 			"update",
	// 		);
	// 	await delay(shortestDelay, interruptible);
	// }

	const resetCommands = [
		["Emulation.clearDeviceMetricsOverride", {}],
		["Network.setUserAgentOverride", { userAgent: "" }],
		["Network.setBypassServiceWorker", { bypass: false }],
		["Emulation.setTouchEmulationEnabled", { enabled: false }],
		["Emulation.setEmitTouchEventsForMouse", { enabled: false }],
	];
	for (const [command, params] of resetCommands) {
		try {
			await race(
				chrome.debugger.sendCommand(
					{ tabId },
					command,
					params,
				),
				shortestDelay,
			);
			logs &&
				log(
					`[DETACH] - Reset command sent: ${command} with params: ${JSON.stringify(
						params,
					)}`,
					"success",
				);
		} catch (error) {
			logs &&
				log(
					`[DETACH] - Error sending reset command ${command}: ${error.message}`,
					"error",
				);
			continue;
		}
	}
	await delay(shortestDelay, interruptible);
	try {
		await race(
			chrome.debugger.detach({ tabId }),
			mediumDelay,
			`Failed to detach debugger from tab ${tabId} within timeout.`,
		);
		logs &&
			log(
				`[DETACH] - Debugger detached from tab ${tabId}.`,
				"success",
			);
	} catch (error) {
		log(
			`[DETACH] - Error detaching tab: ${error.message}`,
			"error",
		);
		return false;
	}
	// if (tabId && originalUrl) {
	// 	await chrome.tabs.update(tabId, {
	// 		url: originalUrl,
	// 	});
	// 	await wait(tabId);
	// 	logs &&
	// 		log(
	// 			`[DETACH] Tab updated to original URL: ${originalUrl}`,
	// 			"update",
	// 		);
	// 	await delay(shortestDelay, interruptible);
	// }
	return true;
}

async function toggleSimulate() {
	try {
		const currentTab = await chrome.tabs.query({
			active: true,
			currentWindow: true,
		});
		const tabId = currentTab?.[0]?.id;
		if (!tabId) {
			logs &&
				log(
					"[TOGGLE SIMULATE] No active tab found.",
					"error",
				);
			return false;
		}
		const isAttached = await isDebuggerAttached(tabId);
		if (!isAttached) {
			await attach(tabId, false);
			await delay(shortestDelay, false);
			await simulate(tabId, false);
			logs &&
				log(
					`[TOGGLE SIMULATE] Debugger attached and simulated for tab ${tabId}.`,
					"success",
				);
			return true;
		} else {
			await detach(tabId, false);
			await delay(shortestDelay, false);
			logs &&
				log(
					`[TOGGLE SIMULATE] Debugger detached from tab ${tabId}.`,
					"success",
				);
			return true;
		}
	} catch (error) {
		log(
			`[TOGGLE SIMULATE] Error toggling simulate: ${error.message}`,
			"error",
		);
		return false;
	}
}

async function enableDomains(tabId) {
	tabId = Number(tabId);
	try {
		const domains = ["Page", "Runtime", "DOM"];
		await chrome.tabs.update(tabId, {
			active: true,
		});
		for (const domain of domains) {
			await race(
				chrome.debugger.sendCommand(
					{ tabId },
					`${domain}.enable`,
					{},
				),
				shortestDelay,
				`Failed to enable ${domain} domain for tab ${tabId} within timeout.`,
			);
		}
		logs &&
			log(
				`[ENABLE DOMAINS] - Enabled domains for tab ${tabId}.`,
				"success",
			);
		await delay(shortestDelay, true);
		return true;
	} catch (error) {
		log(
			`[ENABLE DOMAINS] - Error enabling domains for tab ${tabId}: ${error.message}`,
			"error",
		);
		return false;
	}
}

async function click(interruptible = true) {
	if (interruptible && !config?.runtime?.running) {
		logs &&
			log(
				"[CLICK] Interrupted, skipping click operation.",
				"warning",
			);
		return false;
	}

	const tabId = Number(config?.runtime?.rsaTab);
	if (!tabId) {
		logs &&
			log(
				"[CLICK] No RSA tab found, skipping click operation.",
				"warning",
			);
		return false;
	}

	try {
		await enableDomains(tabId);
		const selector = config?.runtime?.mobile
			? "#mHamburger"
			: ".b_clickarea";

		const { root: documentNode } = await race(
			chrome.debugger.sendCommand(
				{ tabId },
				"DOM.getDocument",
			),
			shortestDelay,
			`Failed to get document for tab ${tabId} within timeout.`,
		);

		if (!documentNode || !documentNode.nodeId) {
			logs &&
				log(
					`[CLICK] - Failed to get document node for tab ${tabId}.`,
					"error",
				);
			return false;
		}

		const { nodeId } = await race(
			chrome.debugger.sendCommand(
				{ tabId },
				"DOM.querySelector",
				{
					nodeId: documentNode.nodeId,
					selector: selector,
				},
			),
			shortestDelay,
			`Failed to query selector "${selector}" for tab ${tabId} within timeout.`,
		);
		if (!nodeId) {
			logs &&
				log(
					`[CLICK] - Failed to get node ID for selector "${selector}" in tab ${tabId}.`,
					"error",
				);
			return false;
		}

		await race(
			chrome.debugger.sendCommand(
				{ tabId },
				"DOM.scrollIntoViewIfNeeded",
				{
					nodeId: nodeId,
				},
			),
			shortestDelay,
			`Failed to scroll into view for node ID ${nodeId} in tab ${tabId} within timeout.`,
		);
		await delay(shortestDelay, interruptible);

		const { model } = await race(
			chrome.debugger.sendCommand(
				{ tabId },
				"DOM.getBoxModel",
				{
					nodeId: nodeId,
				},
			),
			shortestDelay,
			`Failed to get box model for node ID ${nodeId} in tab ${tabId} within timeout.`,
		);
		if (!model) {
			logs &&
				log(
					`[CLICK] - Invalid box model for node ID ${nodeId} in tab ${tabId}.`,
					"error",
				);
			return false;
		}

		const quad = model?.content;
		const x = (quad[0] + quad[2]) / 2;
		const y = (quad[1] + quad[5]) / 2;
		logs &&
			log(
				`[CLICK] - Click coordinates for tab ${tabId}: (${x}, ${y})`,
				"update",
			);

		if (config?.runtime?.mobile) {
			await race(
				chrome.debugger.sendCommand(
					{ tabId },
					"Input.dispatchTouchEvent",
					{
						type: "touchStart",
						touchPoints: [
							{
								x,
								y,
								radiusX: 5,
								radiusY: 5,
								force: 0.5,
							},
						],
					},
				),
				shortestDelay,
				`Failed to dispatch touch event for tab ${tabId} within timeout.`,
			);
		} else {
			await race(
				chrome.debugger.sendCommand(
					{ tabId },
					"Input.dispatchMouseEvent",
					{
						type: "mouseMoved",
						button: "left",
						x,
						y,
						clickCount: 1,
					},
				),
				shortestDelay,
				`Failed to dispatch mouse event for tab ${tabId} within timeout.`,
			);
			await delay(80 + Math.random() * 120, interruptible);
			await race(
				chrome.debugger.sendCommand(
					{ tabId },
					"Input.dispatchMouseEvent",
					{
						type: "mousePressed",
						button: "left",
						x,
						y,
						clickCount: 1,
					},
				),
				shortestDelay,
				`Failed to dispatch mouse event for tab ${tabId} within timeout.`,
			);
		}
		await delay(80 + Math.random() * 120, interruptible);
		if (config?.runtime?.mobile) {
			await race(
				chrome.debugger.sendCommand(
					{ tabId },
					"Input.dispatchTouchEvent",
					{
						type: "touchEnd",
						touchPoints: [
							{
								x,
								y,
								radiusX: 5,
								radiusY: 5,
								force: 0.5,
							},
						],
					},
				),
				shortestDelay,
				`Failed to dispatch touch event for tab ${tabId} within timeout.`,
			);
		} else {
			await race(
				chrome.debugger.sendCommand(
					{ tabId },
					"Input.dispatchMouseEvent",
					{
						type: "mouseReleased",
						button: "left",
						x,
						y,
						clickCount: 1,
					},
				),
				shortestDelay,
				`Failed to dispatch mouse event for tab ${tabId} within timeout.`,
			);
		}
		logs &&
			log(
				`[CLICK] - Click operation completed for tab ${tabId}.`,
				"success",
			);
		await delay(shortestDelay, interruptible);
	} catch (error) {
		log(
			`[CLICK] - Error during click operation: ${error.message}`,
			"error",
		);
	} finally {
		logs &&
			log(
				`[CLICK] - Applying fallback method for login for tab ${tabId}.`,
				"update",
			);
		await chrome.tabs.sendMessage(tabId, {
			action: "login",
			mobile: config?.runtime?.mobile,
		});
		await delay(shortestDelay, interruptible);
		if (needPatch) {
			needPatch = false;
		}
		return true;
	}
}

async function query(interruptible = true) {
	if (interruptible && !config?.runtime?.running) {
		logs &&
			log(
				"[QUERY] Interrupted, skipping query operation.",
				"warning",
			);
		return false;
	}
	const tabId = Number(config?.runtime?.rsaTab);
	if (!tabId) {
		logs &&
			log(
				"[QUERY] No RSA tab found, skipping query operation.",
				"warning",
			);
		return false;
	}
	logs &&
		log(
			`[QUERY] - Starting query operation for tab ${tabId}...`,
			"update",
		);
	let niche = config?.control?.niche || "random";
	const categories = Object.keys(queries);
	if (niche === "random") {
		niche =
			categories[
				Math.floor(Math.random() * categories.length)
			];
	}
	let queryList = queries[niche];
	searchQuery = queryList[Math.floor(Math.random() * queryList.length)];
	const currentYear = new Date().getFullYear();
	searchQuery = searchQuery
		.replace("[year]", currentYear.toString())
		.replace("[country]", config?.runtime?.country);
	searchQuery = addErrors(searchQuery);
	logs && log(`[QUERY] - Search query: ${searchQuery}`, "update");

	try {
		await enableDomains(tabId);
		await delay(shortestDelay, interruptible);
		const isAttached = await isDebuggerAttached(tabId);
		if (!isAttached) {
			await attach(tabId, interruptible);
			await delay(shortestDelay, interruptible);
		}
		const expression = `(function() {
			const input = document.querySelector("#sb_form_q");
			if (input) {
				input.focus();
				input.value = "";
				input.dispatchEvent(new Event("input", { bubbles: true }));
				return true;
			}
			return false;
		})()`;
		await race(
			chrome.debugger.sendCommand(
				{ tabId },
				"Runtime.evaluate",
				{
					expression: expression,
					allowUnsafeEvalBlockedByCSP: true,
					returnByValue: true,
				},
			),
			shortestDelay,
			`Failed to clear search input for tab ${tabId} within timeout.`,
		);
		await delay(shortestDelay, interruptible);
		for (const char of searchQuery) {
			if (!config?.runtime?.running) {
				logs &&
					log(
						"[QUERY] Interrupted during typing, stopping query.",
						"warning",
					);
				return false;
			}
			await race(
				chrome.debugger.sendCommand(
					{ tabId },
					"Input.insertText",
					{
						text: char,
					},
				),
				shortestDelay,
				`Failed to insert text for tab ${tabId} within timeout.`,
			);
			await delay(80 + Math.random() * 120, interruptible);
		}
		logs &&
			log(
				`[QUERY] - Search query typed: ${searchQuery}`,
				"update",
			);
		await delay(shortestDelay, interruptible);
	} catch (error) {
		log(
			`[QUERY] - Error during query operation: ${error.message}`,
			"error",
		);
	} finally {
		await chrome.tabs.sendMessage(tabId, {
			action: "query",
			query: searchQuery,
		});
		await delay(shortestDelay, interruptible);
		logs &&
			log(
				`[QUERY] - Search query sent: ${searchQuery}`,
				"update",
			);
		return true;
	}
}

function addErrors(
	query,
	errorRate = 0.005,
	swapRate = 0.005,
	chancesOfError = 0.1,
) {
	if (Math.random() > chancesOfError) return query;
	const keyboardMap = {
		a: ["s", "q", "w", "z"],
		b: ["v", "g", "h", "n"],
		c: ["x", "d", "f", "v"],
		d: ["s", "e", "r", "f", "c", "x"],
		e: ["w", "s", "d", "r"],
		f: ["d", "r", "t", "g", "v", "c"],
		g: ["f", "t", "y", "h", "b", "v"],
		h: ["g", "y", "u", "j", "n", "b"],
		i: ["u", "j", "k", "o"],
		j: ["h", "u", "i", "k", "m", "n"],
		k: ["j", "i", "o", "l", "m"],
		l: ["k", "o", "p"],
		m: ["n", "j", "k"],
		n: ["b", "h", "j", "m"],
		o: ["i", "k", "l", "p"],
		p: ["o", "l"],
		q: ["a", "w"],
		r: ["e", "d", "f", "t"],
		s: ["a", "w", "e", "d", "x", "z"],
		t: ["r", "f", "g", "y"],
		u: ["y", "h", "j", "i"],
		v: ["c", "f", "g", "b"],
		w: ["q", "a", "s", "e"],
		x: ["z", "s", "d", "c"],
		y: ["t", "g", "h", "u"],
		z: ["a", "s", "x"],
	};
	const getNearbyChar = (char) => {
		const lower = char.toLowerCase();
		const neighbors = keyboardMap[lower];
		if (!neighbors || neighbors.length === 0) return char;
		const swap =
			neighbors[Math.floor(Math.random() * neighbors.length)];
		return char === lower ? swap : swap.toUpperCase();
	};
	let result = "";
	let errorCount = 0;
	for (let i = 0; i < query.length; i++) {
		let char = query[i];
		// Skip chance (omit a character)
		if (
			Math.random() < errorRate &&
			errorCount < 2 &&
			/[a-zA-Z]/.test(char)
		) {
			errorCount++;
			continue;
		}
		// Duplicate chance
		if (
			Math.random() < errorRate &&
			errorCount < 2 &&
			/[a-zA-Z]/.test(char)
		) {
			result += char;
			errorCount++;
		}
		// Swap with nearby key
		if (
			Math.random() < swapRate &&
			errorCount < 2 &&
			/[a-zA-Z]/.test(char)
		) {
			result += getNearbyChar(char);
			errorCount++;
		} else {
			result += char;
		}
	}
	return result;
}

async function perform(interruptible = true) {
	if (interruptible && !config?.runtime?.running) {
		logs &&
			log(
				"[PERFORM] Interrupted, skipping perform operation.",
				"warning",
			);
		return false;
	}
	const tabId = Number(config?.runtime?.rsaTab);
	if (!tabId) {
		logs &&
			log(
				"[PERFORM] No RSA tab found, skipping perform operation.",
				"warning",
			);
		return false;
	}
	const originalUrl = await getTabUrl(tabId);
	logs && log("[PERFORM] Starting perform operation...", "update");
	try {
		await enableDomains(tabId);
		await delay(shortestDelay, interruptible);
		await chrome.tabs.sendMessage(tabId, {
			action: "perform",
			query: searchQuery,
		});
		logs &&
			log(
				`[PERFORM] - Search query sent: ${searchQuery}`,
				"update",
			);
		await wait(tabId);
		await delay(shortestDelay, interruptible);
		const newUrl = await getTabUrl(tabId);
		if (newUrl && newUrl !== originalUrl) {
			logs &&
				log(
					`[PERFORM] - Search performed. URL changed from ${originalUrl} to ${newUrl}`,
					"success",
				);
			return true;
		} else {
			logs &&
				log(
					`[PERFORM] - Search failed and URL did not change: ${originalUrl}`,
					"error",
				);
			return false;
		}
	} catch (error) {
		log(
			`[PERFORM] - Error during perform operation: ${error.message}`,
			"error",
		);
		return false;
	}
}

async function search(searches, min, max, interruptible = true) {
	if (interruptible && !config?.runtime?.running) {
		logs &&
			log(
				"[SEARCH] Interrupted, skipping search operation.",
				"warning",
			);
		return false;
	}
	if (!navigator.onLine) {
		logs &&
			log(
				"[SEARCH] No internet connection, skipping search operation.",
				"warning",
			);
		return false;
	}
	if (!searches) {
		logs &&
			log(
				"[SEARCH] No searches provided, skipping search operation.",
				"warning",
			);
		return false;
	}
	logs && log("[SEARCH] Starting search operation...", "update");
	const tabId = Number(config?.runtime?.rsaTab);
	const originalUrl = await getTabUrl(tabId);
	const clearIt = config?.control?.clear;

	if (clearIt) await clear();
	await delay(shortestDelay, interruptible);
	if (originalUrl && originalUrl !== bing) {
		await chrome.tabs.update(tabId, {
			url: bing,
		});
		await wait(tabId);
		await delay(shortestDelay, interruptible);
		logs &&
			log(
				`[SEARCH] Tab updated to Bing URL: ${bing}`,
				"update",
			);
	}
	alive = setInterval(async () => {
		await chrome.tabs.sendMessage(tabId, {
			action: "ping",
		});
		await chrome.tabs.update(tabId, { highlighted: true });
	}, longestDelay);

	for (let i = 0; i < searches; i++) {
		if (interruptible && !config?.runtime?.running) {
			logs &&
				log(
					"[SEARCH] Interrupted, skipping search operation.",
					"warning",
				);
			return false;
		}
		if (!navigator.onLine) {
			logs &&
				log(
					"[SEARCH] No internet connection, skipping search operation.",
					"warning",
				);
			return false;
		}
		if (needPatch && clearIt && config?.runtime?.mobile) {
			logs &&
				log(
					"[SEARCH] Need patch, clearing browsing data...",
					"warning",
				);
			await clear();
			await delay(shortestDelay, interruptible);
			await click(interruptible);
			await delay(shortestDelay, interruptible);
		}
		const randomDelay =
			Math.floor(
				Math.random() * (max * 1000 - min * 1000 + 1),
			) +
			min * 1000;
		if (clearIt && i < 3) {
			await chrome.tabs.update(tabId, {
				active: true,
			});
			await delay(shortestDelay, interruptible);
			await click(interruptible);
			await delay(shortestDelay, interruptible);
		}
		const queried = await query(interruptible);
		if (!queried) {
			logs &&
				log(
					`[SEARCH] Query failed for ${searchQuery}.`,
					"error",
				);
		}
		await delay(randomDelay, interruptible);
		const stored = await get();
		if (stored) {
			Object.assign(config, stored);
		}
		const searched = await perform(interruptible);
		if (!searched) {
			await chrome.tabs.update(tabId, {
				url: bing,
				active: true,
			});
			await wait(tabId);
			config.runtime.failed++;
			logs &&
				log(
					`[SEARCH] Search ${
						i + 1
					} failed with query: ${searchQuery}.`,
					"error",
				);
		} else {
			config.runtime.done++;
			logs &&
				log(
					`[SEARCH] Search ${
						i + 1
					} performed with query: ${searchQuery}.`,
					"success",
				);
		}
		await set(config);
		await chrome.action.setBadgeText({
			text:
				Math.round(
					((config.runtime.done +
						config.runtime.failed) /
						config.runtime.total) *
						100,
				) + "%",
		});
		if (i === searches - 1) {
			logs &&
				log(
					"[SEARCH] Waiting for final delay...",
					"update",
				);
			await delay(randomDelay, interruptible);
		} else {
			logs &&
				log(
					"[SEARCH] Waiting for longer delay...",
					"update",
				);
			await delay(mediumDelay, interruptible);
		}
	}

	clearInterval(alive);
	await chrome.tabs.update(tabId, {
		url: loading + "complete",
	});
	await wait(tabId);
	return true;
}


async function waitForUrl(tabId, predicate, timeout = longestDelay * 2) {
	const startTime = Date.now();
	return new Promise((resolve) => {
		let resolved = false;
		let timer = null;

		const done = (success, url = "") => {
			if (resolved) return;
			resolved = true;
			clearTimeout(timer);
			chrome.tabs.onUpdated.removeListener(onUpdated);
			logs &&
				log(
					`[WAIT URL] ${success ? "Matched" : "Timed out"} for tab ${tabId}: ${url} (${Date.now() - startTime}ms)`,
					success ? "success" : "warning",
				);
			resolve({ success, url });
		};

		const checkCurrentUrl = async () => {
			try {
				const url = await getTabUrl(tabId);
				if (predicate(url || "")) {
					done(true, url);
				}
			} catch (error) {}
		};

		const onUpdated = (updatedTabId, changeInfo, tab) => {
			if (updatedTabId !== tabId) return;
			const url = changeInfo.url || tab?.url || "";
			if (predicate(url)) {
				done(true, url);
				return;
			}
			if (changeInfo.status === "complete") {
				checkCurrentUrl();
			}
		};

		timer = setTimeout(async () => {
			const url = await getTabUrl(tabId);
			done(false, url || "");
		}, timeout);

		chrome.tabs.onUpdated.addListener(onUpdated);
		checkCurrentUrl();
	});
}

async function completeRewardActivityTab(tabId) {
	tabId = Number(tabId);
	if (!tabId) return false;

	let attachedHere = false;
	let interactions = 0;
	try {
		await wait(tabId);
		await delay(mediumDelay, false);

		const alreadyAttached = await isDebuggerAttached(tabId);
		if (!alreadyAttached) {
			attachedHere = await attach(tabId, false);
		}
		if (!alreadyAttached && !attachedHere) return false;

		await enableDomains(tabId);

		const solveScript = `
			(function() {
				const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
				const isVisible = (el) => {
					if (!el) return false;
					const rect = el.getBoundingClientRect();
					const style = getComputedStyle(el);
					return rect.width > 0 &&
						rect.height > 0 &&
						style.display !== 'none' &&
						style.visibility !== 'hidden' &&
						!el.disabled &&
						el.getAttribute('aria-disabled') !== 'true';
				};
				const clickTargetFor = (el) =>
					el.closest('button, a[href], [role="button"], [role="radio"], [tabindex]:not([tabindex="-1"])') ||
					el.closest('label') ||
					el;
				const selectors = [
					'input[type="radio"]:not(:checked)',
					'[data-option-index]',
					'[data-testid*="answer" i]',
					'[data-testid*="option" i]',
					'button',
					'[role="button"]',
					'[role="radio"]',
					'.rqOption',
					'.rq_button',
					'.wk_choicesInstLink',
					'.bt_option',
					'.quizOption',
					'[class*="option"]',
					'[aria-label]'
				].join(',');
				const rejectText = /share|see results|feedback|close|back|sign in|skip|settings|privacy|terms|dashboard|rewards home|^search$|images|videos|maps|news|shopping|copilot/i;
				const hardRejectText = /download|install|add to|extension|browser extension|subscribe|subscription|trial|set default|make default|open app|get app|mobile app|redeem|gift card|coupon|discount|cashback|shop now|buy now|donate|sweepstake|entries/i;
				const hardRejectHref = /chrome\\.google|microsoftedge\\.microsoft\\.com|apps\\.microsoft\\.com|\\/rewards\\/redeem|shopping|cashback|coupon|discount|subscribe|download|install/i;
				const preferText = /answer|option|choice|start|play|next|continue|submit|quiz|poll|true|false/i;
				const rewardPage = /quiz|poll|rewards|bing\\.com\\/search/i.test(location.href + ' ' + document.title);
				const isSearchActivity = /bing\\.com\\/search/i.test(location.href);
				if (isSearchActivity && !sessionStorage.getItem('rsaSearchActivityViewed')) {
					sessionStorage.setItem('rsaSearchActivityViewed', '1');
					window.scrollBy({
						top: Math.max(300, Math.floor(window.innerHeight * 0.75)),
						left: 0,
						behavior: 'smooth'
					});
					return {
						clicked: true,
						text: 'viewed Bing search results',
						url: location.href
					};
				}
				const candidates = Array.from(document.querySelectorAll(selectors));

				for (const candidate of candidates) {
					const target = clickTargetFor(candidate);
					if (!isVisible(target)) continue;
					if (target.getAttribute('aria-checked') === 'true') continue;
					if (target.getAttribute('aria-pressed') === 'true') continue;

					const text = normalize(
						target.innerText ||
						target.textContent ||
						target.value ||
						target.getAttribute('aria-label') ||
						candidate.getAttribute('aria-label')
					);
					const href = String(target.href || target.closest('a[href]')?.href || '');
					const combinedText = normalize([
						text,
						target.getAttribute('aria-label'),
						target.getAttribute('title'),
						candidate.getAttribute('aria-label'),
						href
					].filter(Boolean).join(' '));
					if (hardRejectText.test(combinedText) || hardRejectHref.test(href)) continue;
					const hasRadio = candidate.matches('input[type="radio"]') || target.getAttribute('role') === 'radio';
					const className = String(candidate.className || target.className || '');
					const hasRewardClass = /option|answer|choice|quiz|poll|rq|wk_|bt_/i.test(className);
					const isUsefulText = text.length > 0 && text.length < 160 && !rejectText.test(text);
					const isPlainRewardButton = rewardPage && target.tagName === 'BUTTON' && isUsefulText && preferText.test(text);
					const isDataOption = candidate.hasAttribute('data-option-index') ||
						/answer|option/i.test(candidate.getAttribute('data-testid') || '');

					if (!hasRadio && !hasRewardClass && !preferText.test(text) && !isPlainRewardButton && !isDataOption) continue;
					if (rejectText.test(text)) continue;

					target.scrollIntoView({ block: 'center', inline: 'center' });
					target.click();
					return {
						clicked: true,
						text: text.slice(0, 80) || target.tagName,
						url: location.href
					};
				}

				return {
					clicked: false,
					title: document.title,
					url: location.href
				};
			})()
		`;

		for (let attempt = 0; attempt < 8; attempt++) {
			const result = await race(
				chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
					expression: solveScript,
					returnByValue: true,
				}),
				mediumDelay,
				`Failed to interact with reward tab ${tabId}.`,
			).catch((error) => {
				logs &&
					log(
						`[ACTIVITY] Reward tab interaction failed: ${error.message}`,
						"warning",
					);
				return null;
			});
			const value = result?.result?.value;
			if (!value?.clicked) break;

			interactions++;
			logs &&
				log(
					`[ACTIVITY] Reward tab ${tabId} clicked: ${value.text}`,
					"update",
				);
			await delay(1200 + Math.random() * 800, false);
			await wait(tabId);
		}
	} catch (error) {
		logs &&
			log(
				`[ACTIVITY] Error completing reward tab ${tabId}: ${error.message}`,
				"error",
			);
	} finally {
		if (attachedHere) {
			await detach(tabId, false);
		}
	}

	return interactions > 0;
}

function createDashboardActivityScript(visitedKeys, safetyLimit = 12) {
	return `
		(function() {
			const clicked = [];
			const skipped = [];
			const openedKeys = [];
			const visited = new Set(${JSON.stringify(visitedKeys || [])});
			const seen = new Set();
			const safetyLimit = ${Number(safetyLimit) || 12};
			const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
			const textOf = (el) => {
				const visible = normalize(el?.innerText || el?.textContent || '');
				const accessible = normalize([
					el?.getAttribute?.('aria-label'),
					el?.getAttribute?.('title')
				].filter(Boolean).join(' '));
				if (!visible) return accessible;
				if (!accessible) return visible;
				return visible.toLowerCase().includes(accessible.toLowerCase()) ?
					visible :
					normalize(visible + ' ' + accessible);
			};
			const dailySetPattern = /\\bdaily set\\b/i;
			const nextSectionPattern = /\\b(your activity|more activities|punch cards?|earn more|recommended|quests?|activities)\\b/i;
			const isVisible = (el) => {
				if (!el) return false;
				const rect = el.getBoundingClientRect();
				const style = getComputedStyle(el);
				return rect.width > 0 &&
					rect.height > 0 &&
					style.display !== 'none' &&
					style.visibility !== 'hidden' &&
					el.getAttribute('aria-hidden') !== 'true' &&
					el.getAttribute('aria-disabled') !== 'true' &&
					!el.disabled;
			};
			const isDone = (el) => {
				const txt = textOf(el).toLowerCase();
				if (/completed|not eligible|earned last month|already done|claimed|you did it/i.test(txt)) return true;
				let node = el;
				for (let i = 0; node && i < 6; i++) {
					const className = String(node.className || '').toLowerCase();
					if (className.includes('complete') || className.includes('done')) return true;
					node = node.parentElement;
				}
				return false;
			};
			const headingNodes = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"]'))
				.filter(isVisible)
				.map((el) => ({ el, text: textOf(el), rect: el.getBoundingClientRect() }))
				.filter((item) => item.text.length > 0)
				.sort((a, b) => a.rect.top - b.rect.top);
			const dailyHeading = headingNodes.find((item) => dailySetPattern.test(item.text));
			if (!dailyHeading) {
				return {
					clicked,
					skipped,
					openedKeys,
					reason: 'daily set heading not found',
					url: location.href,
					title: document.title
				};
			}
			const nextHeading = headingNodes.find((item) =>
				item.rect.top > dailyHeading.rect.bottom + 4 &&
				nextSectionPattern.test(item.text)
			);
			const dailyTop = dailyHeading.rect.bottom - 8;
			const dailyBottom = nextHeading ?
				nextHeading.rect.top - 8 :
				dailyHeading.rect.bottom + Math.max(260, window.innerHeight * 0.5);
			const isInsideDailySet = (el) => {
				const rect = el.getBoundingClientRect();
				return rect.bottom >= dailyTop && rect.top < dailyBottom;
			};
			const nearestCard = (node) =>
				node.closest?.('article, li, [class*="card"], [class*="Card"], [class*="tile"], [class*="Tile"], [data-testid]') ||
				node;
			const actionTargetFor = (node) => {
				const card = nearestCard(node);
				return (
					node.matches?.('a[href], button, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])') ? node :
					node.closest?.('a[href], button, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])') ||
					card.querySelector?.('a[href], button, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])') ||
					card
				);
			};
			const keyFor = (target, type, text) => {
				const href = target.href || target.closest?.('a[href]')?.href || '';
				const rect = target.getBoundingClientRect();
				return href ?
					href :
					text + '|' + Math.round(rect.top) + '|' + Math.round(rect.left);
			};
			const clickLikeUser = (target) => {
				try {
					target.focus?.({ preventScroll: true });
				} catch (error) {}
				for (const type of ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
					try {
						target.dispatchEvent(new MouseEvent(type, {
							bubbles: true,
							cancelable: true,
							view: window
						}));
					} catch (error) {}
				}
				if (typeof target.click === 'function') {
					target.click();
				} else {
					target.dispatchEvent(new MouseEvent('click', {
						bubbles: true,
						cancelable: true,
						view: window
					}));
				}
			};
			const openTarget = (target, type, text) => {
				if (!target || !isVisible(target) || clicked.length >= safetyLimit) return false;
				const key = keyFor(target, type, text);
				if (visited.has(key) || seen.has(key)) return false;
				seen.add(key);
				openedKeys.push(key);
				target.scrollIntoView({ block: 'center', inline: 'center' });
				const anchor = target.matches?.('a[href]') ? target : target.closest?.('a[href]');
				if (anchor) {
					anchor.target = '_blank';
					anchor.rel = 'noopener noreferrer';
				}
				clickLikeUser(target);
				clicked.push({ type, text: text.slice(0, 90), key });
				return true;
			};
			const pointPattern = /\\+\\s*\\d+\\b|\\b\\d+\\s*(points?|pts?)\\b/i;
			const activityHrefPattern = /quiz|poll|punch|quest|activity|explore|dset|offer|reward|msrewards|rewards/i;
			const activityTextPattern = /quiz|poll|play|watch|explore|search now|complete|claim|check.?in|view|start|earn/i;
			const skipPattern = /learn more|about|dashboard|earn more only|progress|streak|bonus|goal|member|available|ready to claim|coupon|search:\\s*\\d|activity:\\s*\\d|check.?in:\\s*\\d|not eligible|completed|privacy|terms|download app/i;
			const expandPattern = /(^|\\b)(earn more|show more|see more|view all|load more|more activities|expand|ki\\u1ebfm th\\u00eam|xem th\\u00eam|hi\\u1ec3n th\\u1ecb th\\u00eam|m\\u1edf r\\u1ed9ng)(\\b|$)/i;

			const nodes = Array.from(document.querySelectorAll(
				'a[href], button, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"]), article, li, [data-testid], [class*="card"], [class*="Card"], [class*="tile"], [class*="Tile"]'
			));
			for (const node of nodes) {
				if (clicked.length >= safetyLimit) break;
				if (!isVisible(node)) continue;

				const card = nearestCard(node);
				const target = actionTargetFor(node);
				if (!target || !isVisible(target)) continue;
				if (!isInsideDailySet(card)) continue;

				const text = textOf(card) || textOf(target);
				if (!text || text.length < 3) continue;
				if (text.length > 500) continue;
				if (expandPattern.test(text) && !pointPattern.test(text)) continue;

				const href = String(target.href || target.closest?.('a[href]')?.href || '').toLowerCase();
				const type = 'daily-set';

				if (isDone(card)) {
					if (pointPattern.test(text) || activityHrefPattern.test(href)) {
						skipped.push({ type, text: text.slice(0, 90), reason: 'already done' });
					}
					continue;
				}
				if (skipPattern.test(text)) continue;

				const score =
					(pointPattern.test(text) ? 4 : 0) +
					(activityHrefPattern.test(href) ? 4 : 0) +
					(activityTextPattern.test(text) ? 2 : 0) +
					2;
				if (score < 4) continue;

				openTarget(target, type, text);
			}

			return {
				clicked,
				skipped,
				openedKeys,
				safetyLimit,
				url: location.href,
				title: document.title
			};
		})()
	`;
}

function createEarnActivityScript(visitedKeys, safetyLimit = 12) {
	return `
		(function() {
			const clicked = [];
			const skipped = [];
			const openedKeys = [];
			const visited = new Set(${JSON.stringify(visitedKeys || [])});
			const seen = new Set();
			const safetyLimit = ${Number(safetyLimit) || 12};
			const normalize = (value) => (value || '').replace(/\\s+/g, ' ').trim();
			const textOf = (el) => {
				const visible = normalize(el?.innerText || el?.textContent || '');
				const accessible = normalize([
					el?.getAttribute?.('aria-label'),
					el?.getAttribute?.('title')
				].filter(Boolean).join(' '));
				if (!visible) return accessible;
				if (!accessible) return visible;
				return visible.toLowerCase().includes(accessible.toLowerCase()) ?
					visible :
					normalize(visible + ' ' + accessible);
			};
			const isVisible = (el) => {
				if (!el) return false;
				const rect = el.getBoundingClientRect();
				const style = getComputedStyle(el);
				return rect.width > 0 &&
					rect.height > 0 &&
					style.display !== 'none' &&
					style.visibility !== 'hidden' &&
					el.getAttribute('aria-hidden') !== 'true' &&
					el.getAttribute('aria-disabled') !== 'true' &&
					!el.disabled;
			};
			const skipReasonFor = (el) => {
				const txt = textOf(el).toLowerCase();
				if (/silver level required|gold level required|level required|\\brequired\\b|not eligible|locked/i.test(txt)) {
					return 'required or locked';
				}
				if (/completed|earned last month|already done|claimed|you did it/i.test(txt)) {
					return 'already completed';
				}
				const lockProbe = Array.from(el.querySelectorAll('[aria-label], [title], [class]'))
					.some((node) => /lock|locked|level required|\\brequired\\b/i.test([
						node.getAttribute('aria-label'),
						node.getAttribute('title'),
						String(node.className || '')
					].filter(Boolean).join(' ')));
				if (lockProbe) return 'required or locked';
				let node = el;
				for (let i = 0; node && i < 6; i++) {
					const className = String(node.className || '').toLowerCase();
					if (className.includes('locked') || className.includes('required')) return 'required or locked';
					if (className.includes('complete') || className.includes('done')) return 'already completed';
					node = node.parentElement;
				}
				return '';
			};
			const markerNodes = Array.from(document.querySelectorAll('h1, h2, h3, [role="heading"], div, span, p'))
				.filter(isVisible)
				.map((el) => ({ el, text: textOf(el), rect: el.getBoundingClientRect() }))
				.filter((item) => item.text.length > 0 && item.text.length < 160)
				.sort((a, b) => a.rect.top - b.rect.top);
			const keepHeading = markerNodes.find((item) => /\\bkeep earning\\b/i.test(item.text));
			if (!keepHeading) {
				const doc = document.documentElement;
				const maxScroll = Math.max(
					doc.scrollHeight || 0,
					document.body?.scrollHeight || 0
				);
				const canScroll = window.scrollY + window.innerHeight < maxScroll - 20;
				if (canScroll) {
					window.scrollBy({
						top: Math.max(520, Math.floor(window.innerHeight * 0.85)),
						left: 0,
						behavior: 'instant'
					});
				}
				return {
					clicked,
					skipped,
					openedKeys,
					retry: canScroll,
					reason: canScroll ?
						'scrolled while looking for Keep earning' :
						'keep earning heading not found',
					url: location.href,
					title: document.title
				};
			}
			const keepTop = keepHeading.rect.bottom - 8;
			const isInsideEarnArea = (el) => {
				const rect = el.getBoundingClientRect();
				return rect.bottom >= keepTop;
			};
			const nearestCard = (node) =>
				node.closest?.('article, li, [class*="card"], [class*="Card"], [class*="tile"], [class*="Tile"], [data-testid]') ||
				node;
			const actionTargetFor = (node) => {
				const card = nearestCard(node);
				return (
					node.matches?.('a[href], button, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])') ? node :
					node.closest?.('a[href], button, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])') ||
					card.querySelector?.('a[href], button, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])') ||
					card
				);
			};
			const keyFor = (target, type, text) => {
				const href = target.href || target.closest?.('a[href]')?.href || '';
				const rect = target.getBoundingClientRect();
				return href ?
					href :
					text + '|' + Math.round(rect.top) + '|' + Math.round(rect.left);
			};
			const clickLikeUser = (target) => {
				try {
					target.focus?.({ preventScroll: true });
				} catch (error) {}
				for (const type of ['pointerover', 'mouseover', 'pointerdown', 'mousedown', 'pointerup', 'mouseup']) {
					try {
						target.dispatchEvent(new MouseEvent(type, {
							bubbles: true,
							cancelable: true,
							view: window
						}));
					} catch (error) {}
				}
				if (typeof target.click === 'function') {
					target.click();
				} else {
					target.dispatchEvent(new MouseEvent('click', {
						bubbles: true,
						cancelable: true,
						view: window
					}));
				}
			};
			const openTarget = (target, type, text) => {
				if (!target || !isVisible(target) || clicked.length >= safetyLimit) return false;
				const key = keyFor(target, type, text);
				if (visited.has(key) || seen.has(key)) return false;
				seen.add(key);
				openedKeys.push(key);
				target.scrollIntoView({ block: 'center', inline: 'center' });
				const anchor = target.matches?.('a[href]') ? target : target.closest?.('a[href]');
				if (anchor) {
					anchor.target = '_blank';
					anchor.rel = 'noopener noreferrer';
				}
				clickLikeUser(target);
				clicked.push({ type, text: text.slice(0, 90), key });
				return true;
			};
			const nonCardPattern = /privacy|terms|dashboard only|no points|redeem|donate|gift card|sweepstake|entries|coupon|discount|cashback/i;
			const rewardPointsPattern = /(?:^|[^\\d])\\+\\s*[1-9]\\d*(?:\\s*(?:points?|pts?))?\\b|(?:^|[^\\d])(?:[1-9]\\d*)\\s*(?:points?|pts?)\\b/i;
			const zeroPointsPattern = /(?:^|[^\\d])(?:\\+\\s*)?0\\s*(?:points?|pts?)\\b/i;
			const nodes = Array.from(document.querySelectorAll(
				'a[href], button, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"]), article, li, [data-testid], [class*="card"], [class*="Card"], [class*="tile"], [class*="Tile"]'
			));
			for (const node of nodes) {
				if (clicked.length >= safetyLimit) break;
				if (!isVisible(node)) continue;

				const card = nearestCard(node);
				const target = actionTargetFor(node);
				if (!target || !isVisible(target)) continue;
				if (!isInsideEarnArea(card)) continue;

				const text = textOf(card) || textOf(target);
				if (!text || text.length < 3 || text.length > 520) continue;

				const href = String(target.href || target.closest?.('a[href]')?.href || '').toLowerCase();
				const type = 'keep-earning';
				const skipReason = skipReasonFor(card);
				if (skipReason) {
					skipped.push({ type, text: text.slice(0, 90), reason: skipReason });
					continue;
				}
				if (nonCardPattern.test(text)) {
					skipped.push({ type, text: text.slice(0, 90), reason: 'not an earn-points card' });
					continue;
				}
				if (!rewardPointsPattern.test(text) || zeroPointsPattern.test(text)) {
					skipped.push({ type, text: text.slice(0, 90), reason: 'no visible points' });
					continue;
				}
				if (!href && !target.matches?.('button, [role="button"], [role="link"], [tabindex]:not([tabindex="-1"])')) continue;

				openTarget(target, type, text);
			}

			if (clicked.length === 0) {
				const doc = document.documentElement;
				const maxScroll = Math.max(
					doc.scrollHeight || 0,
					document.body?.scrollHeight || 0
				);
				const canScroll = window.scrollY + window.innerHeight < maxScroll - 20;
				if (canScroll) {
					window.scrollBy({
						top: Math.max(520, Math.floor(window.innerHeight * 0.85)),
						left: 0,
						behavior: 'instant'
					});
					return {
						clicked,
						skipped,
						openedKeys,
						retry: true,
						reason: 'scrolled for more earn cards',
						url: location.href,
						title: document.title
					};
				}
			}

			return {
				clicked,
				skipped,
				openedKeys,
				safetyLimit,
				url: location.href,
				title: document.title
			};
		})()
	`;
}

function isRewardActivityUrl(url) {
	const value = String(url || "").toLowerCase();
	return Boolean(
		value &&
			!value.startsWith("chrome://") &&
			!value.startsWith("chrome-extension://") &&
			!value.startsWith("devtools://") &&
			(value.includes("rewards") ||
				msDomains.some((domain) => value.includes(domain))),
	);
}

function getTabActivityUrl(tab) {
	return String(tab?.url || tab?.pendingUrl || "").toLowerCase();
}

function isActivityOpenedTab(tab, mainTabId, existingTabIds) {
	const tabUrl = getTabActivityUrl(tab);
	const openedByMainTab = Number(tab.openerTabId) === Number(mainTabId);
	return Boolean(
		tab?.id &&
			tab.id !== mainTabId &&
			!existingTabIds.has(tab.id) &&
			(openedByMainTab || isRewardActivityUrl(tabUrl)) &&
			!tabUrl.startsWith("chrome://") &&
			!tabUrl.startsWith("chrome-extension://") &&
			!tabUrl.startsWith("devtools://"),
	);
}

async function processOpenedActivityTabs(
	mainTabId,
	existingTabIds,
	returnUrl = rewards + "dashboard",
) {
	const allTabs = await chrome.tabs.query({});
	const newTabs = allTabs.filter((tab) =>
		isActivityOpenedTab(tab, mainTabId, existingTabIds),
	);
	let processed = 0;
	for (const tab of newTabs) {
		const loaded = await waitForUrl(
			tab.id,
			(url) => Boolean(url && url !== "about:blank"),
			mediumDelay,
		);
		const tabUrl = loaded.url || (await getTabUrl(tab.id));
		if (!isRewardActivityUrl(tabUrl)) {
			logs &&
				log(
					`[ACTIVITY] Leaving non-reward tab open: ${tab.id} (${tabUrl || "unknown url"})`,
					"update",
				);
			continue;
		}
		await completeRewardActivityTab(tab.id);
		await delay(shortestDelay, false);
		try {
			await chrome.tabs.remove(tab.id);
		} catch (error) {}
		processed++;
		logs &&
			log(
				`[ACTIVITY] Closed opened tab: ${tab.id} (${tabUrl || "unknown url"})`,
				"update",
			);
	}

	const mainUrl = await getTabUrl(mainTabId);
	if (mainUrl && isRewardActivityUrl(mainUrl) && !mainUrl.startsWith(returnUrl)) {
		await completeRewardActivityTab(mainTabId);
		await chrome.tabs.update(mainTabId, { url: returnUrl, active: true });
		await wait(mainTabId);
		processed++;
	}

	return processed;
}

async function closeOpenedActivityTabs(mainTabId, existingTabIds) {
	const allTabs = await chrome.tabs.query({});
	const openedTabs = allTabs.filter(
		(tab) =>
			isActivityOpenedTab(tab, mainTabId, existingTabIds) &&
			isRewardActivityUrl(getTabActivityUrl(tab)),
	);
	let closed = 0;
	for (const tab of openedTabs) {
		try {
			await chrome.tabs.remove(tab.id);
			closed++;
			logs &&
				log(
					`[ACTIVITY] Cleanup closed leftover tab: ${tab.id} (${tab.url || tab.pendingUrl || "unknown url"})`,
					"update",
				);
		} catch (error) {}
	}
	return closed;
}

async function runDashboardActivityPass(tabId, memory, sessionVisited, pass) {
	const tabsBefore = await chrome.tabs.query({});
	const existingTabIds = new Set(tabsBefore.map((tab) => tab.id));
	const blockedKeys = getBlockedActivityKeys(memory, sessionVisited);
	const beforeScore = await fetchRewardsSnapshot();
	const dashboardScript = createDashboardActivityScript([...blockedKeys]);
	const result = await race(
		chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
			expression: dashboardScript,
			returnByValue: true,
		}),
		longestDelay,
		`Failed to scan rewards dashboard pass ${pass}.`,
	).catch((error) => {
		logs &&
			log(
				`[ACTIVITY] Dashboard pass ${pass} failed: ${error.message}`,
				"warning",
			);
		return null;
	});

	const value = result?.result?.value || {};
	const clickedItems = value.clicked || [];
	const skippedItems = value.skipped || [];
	if (value.reason) {
		logs &&
			log(
				`[ACTIVITY] Dashboard pass ${pass}: ${value.reason}.`,
				"warning",
			);
	}
	for (const key of value.openedKeys || []) {
		sessionVisited.add(key);
	}
	recordActivityAttempts(memory, value.openedKeys || []);

	if (clickedItems.length > 0) {
		logs &&
			log(
				`[ACTIVITY] Pass ${pass} clicked ${clickedItems.length} dashboard items.`,
				"success",
			);
		for (const item of clickedItems) {
			logs &&
				log(
					`[ACTIVITY]   clicked ${item.type}: ${item.text}`,
					"update",
				);
		}
	}
	if (skippedItems.length > 0) {
		logs &&
			log(
				`[ACTIVITY] Pass ${pass} skipped ${skippedItems.length} completed items.`,
				"update",
			);
	}

	await delay(4000 + Math.random() * 2500, false);
	const processedTabs = await processOpenedActivityTabs(tabId, existingTabIds);
	const nonExpandClicks = clickedItems.filter((item) => item.type !== "expand");
	if (nonExpandClicks.length > 0 || processedTabs > 0) {
		await chrome.tabs.update(tabId, { url: rewards + "dashboard", active: true });
		await wait(tabId);
		await delay(mediumDelay, false);
	}
	const afterScore = await fetchRewardsSnapshot();
	const pointDelta = getScoreDelta(beforeScore, afterScore);
	if (afterScore && Number.isFinite(afterScore.score)) {
		memory.lastScore = afterScore.score;
	}
	await saveActivityMemory(memory);

	if (pointDelta !== null) {
		logs &&
			log(
				`[ACTIVITY] Pass ${pass} score delta: ${pointDelta >= 0 ? "+" : ""}${pointDelta}.`,
				pointDelta > 0 ? "success" : "warning",
			);
	}

	return {
		clicked: clickedItems.length,
		nonExpandClicked: nonExpandClicks.length,
		processed: processedTabs,
		skipped: skippedItems.length,
		pointDelta,
	};
}

async function runEarnActivityPass(tabId, memory, sessionVisited, pass) {
	const earnUrl = rewards + "earn";
	const tabsBefore = await chrome.tabs.query({});
	const existingTabIds = new Set(tabsBefore.map((tab) => tab.id));
	const blockedKeys = getBlockedActivityKeys(memory, sessionVisited);
	const beforeScore = await fetchRewardsSnapshot();
	const earnScript = createEarnActivityScript([...blockedKeys]);
	const result = await race(
		chrome.debugger.sendCommand({ tabId }, "Runtime.evaluate", {
			expression: earnScript,
			returnByValue: true,
		}),
		longestDelay,
		`Failed to scan rewards earn pass ${pass}.`,
	).catch((error) => {
		logs &&
			log(`[ACTIVITY] Earn pass ${pass} failed: ${error.message}`, "warning");
		return null;
	});

	const value = result?.result?.value || {};
	const clickedItems = value.clicked || [];
	const skippedItems = value.skipped || [];
	if (value.reason) {
		logs &&
			log(
				`[ACTIVITY] Earn pass ${pass}: ${value.reason}.`,
				"warning",
			);
	}
	for (const key of value.openedKeys || []) {
		sessionVisited.add(key);
	}
	recordActivityAttempts(memory, value.openedKeys || []);

	if (clickedItems.length > 0) {
		logs &&
			log(
				`[ACTIVITY] Earn pass ${pass} clicked ${clickedItems.length} Keep earning items.`,
				"success",
			);
		for (const item of clickedItems) {
			logs &&
				log(
					`[ACTIVITY]   clicked ${item.type}: ${item.text}`,
					"update",
				);
		}
	}
	if (skippedItems.length > 0) {
		logs &&
			log(
				`[ACTIVITY] Earn pass ${pass} skipped ${skippedItems.length} non-point, locked, or completed items.`,
				"update",
			);
	}

	await delay(4000 + Math.random() * 2500, false);
	const processedTabs = await processOpenedActivityTabs(
		tabId,
		existingTabIds,
		earnUrl,
	);
	if (clickedItems.length > 0 || processedTabs > 0) {
		await chrome.tabs.update(tabId, { url: earnUrl, active: true });
		await wait(tabId);
		await delay(mediumDelay, false);
	}
	const afterScore = await fetchRewardsSnapshot();
	const pointDelta = getScoreDelta(beforeScore, afterScore);
	if (afterScore && Number.isFinite(afterScore.score)) {
		memory.lastScore = afterScore.score;
	}
	await saveActivityMemory(memory);

	if (pointDelta !== null) {
		logs &&
			log(
				`[ACTIVITY] Earn pass ${pass} score delta: ${pointDelta >= 0 ? "+" : ""}${pointDelta}.`,
				pointDelta > 0 ? "success" : "warning",
			);
	}

	return {
		clicked: clickedItems.length,
		processed: processedTabs,
		skipped: skippedItems.length,
		retry: Boolean(value.retry),
		pointDelta,
	};
}

async function activity(tabId, interruptible = true) {
	if (interruptible && !config?.runtime?.running && !config?.runtime?.act) {
		logs && log(`[ACTIVITY] Interrupted, skipping activity.`, "warning");
		return false;
	}
	if (!navigator.onLine) {
		logs && log(`[ACTIVITY] No internet connection, skipping.`, "warning");
		return false;
	}
	tabId = Number(tabId);
	if (!tabId) {
		logs && log(`[ACTIVITY] No tab ID, skipping.`, "warning");
		return false;
	}

	config.runtime.act = 1;
	await set(config);
	const shouldContinueActivity = () => !interruptible || isRuntimeActive();
	const activityStartTabs = new Set(
		(await chrome.tabs.query({})).map((tab) => tab.id),
	);
	let clicked = false;
	let debuggerReady = false;
	let activityMemory = null;
	try {
		await chrome.action.setBadgeText({ text: "ACT" });
		await chrome.action.setBadgeBackgroundColor({ color: "#0072FF" });

		await chrome.tabs.update(tabId, { url: rewards + "dashboard", active: true });
		await wait(tabId);
		await delay(mediumDelay, interruptible);
		debuggerReady = await attach(tabId, interruptible);
		if (debuggerReady) {
			await enableDomains(tabId);
		}

		await chrome.tabs.sendMessage(tabId, { action: "closePopups" }).catch(() => {});
		await delay(shortestDelay, interruptible);

		activityMemory = await loadActivityMemory();
		const sessionVisited = new Set();
		let totalClicked = 0;
		let totalProcessed = 0;
		let measuredDelta = 0;
		let idlePasses = 0;
		for (let pass = 1; pass <= 4; pass++) {
			if (!shouldContinueActivity()) break;
			const result = await runDashboardActivityPass(
				tabId,
				activityMemory,
				sessionVisited,
				pass,
			);
			totalClicked += result.clicked;
			totalProcessed += result.processed;
			if (Number.isFinite(result.pointDelta)) {
				measuredDelta += result.pointDelta;
			}
			clicked = totalClicked > 0 || totalProcessed > 0;

			if (result.clicked === 0 && result.processed === 0) {
				idlePasses++;
			} else {
				idlePasses = 0;
			}
			if (idlePasses >= 1) break;
		}

		if (shouldContinueActivity()) {
			if (totalClicked === 0 && totalProcessed === 0) {
				logs &&
					log(`[ACTIVITY] Daily set idle, moving to Keep earning.`, "update");
			}
			logs &&
				log(`[ACTIVITY] Opening Keep earning page.`, "update");
			await chrome.tabs.update(tabId, { url: rewards + "earn", active: true });
			await wait(tabId);
			await delay(mediumDelay, interruptible);
			await chrome.tabs
				.sendMessage(tabId, { action: "closePopups" })
				.catch(() => {});
			idlePasses = 0;

			for (let pass = 1; pass <= 10; pass++) {
				if (!shouldContinueActivity()) break;
				const result = await runEarnActivityPass(
					tabId,
					activityMemory,
					sessionVisited,
					pass,
				);
				totalClicked += result.clicked;
				totalProcessed += result.processed;
				if (Number.isFinite(result.pointDelta)) {
					measuredDelta += result.pointDelta;
				}
				clicked = totalClicked > 0 || totalProcessed > 0;

				if (result.retry) {
					idlePasses = 0;
				} else if (result.clicked === 0 && result.processed === 0) {
					idlePasses++;
				} else {
					idlePasses = 0;
				}
				if (idlePasses >= 2) break;
			}
		} else {
			logs &&
				log(`[ACTIVITY] Keep earning skipped because activity was stopped.`, "warning");
		}

		logs &&
			log(
				`[ACTIVITY] Engine finished. Activity clicks: ${totalClicked}, processed tabs: ${totalProcessed}, measured delta: ${measuredDelta}.`,
				clicked ? "success" : "warning",
			);
	} catch (error) {
		logs && log(`[ACTIVITY] Error: ${error.message}`, "error");
	} finally {
		if (!clicked) {
			logs && log(`[ACTIVITY] No activities to click.`, "success");
		}
		await recordActivityRun(activityMemory);
		config.runtime.act = 0;
		await chrome.action.setBadgeText({ text: "" });
		if (debuggerReady) {
			await detach(tabId, false);
		}
		await closeOpenedActivityTabs(tabId, activityStartTabs);
		await set(config);
		return true;
	}
}


async function initialise(searches) {
	await resetRuntime(config); // reset runtime state of last search session
	if (!navigator.onLine) {
		logs &&
			log(
				"[INITIALISE] No internet connection, skipping initialisation.",
				"warning",
			);
		return false;
	}
	if (searches.desk === 0 && searches.mob === 0) {
		logs &&
			log(
				"[INITIALISE] No searches to perform, skipping initialisation.",
				"warning",
			);
		return false;
	}
	let tabId = null;
	try {
		const rsaTab = await chrome.tabs.create({
			url: bing,
			active: true,
		});
		tabId = Number(rsaTab.id);
		config.runtime.rsaTab = tabId;
		config.runtime.total = searches.desk + searches.mob;
		config.runtime.running = 1;
		await wait(tabId);
		await delay(shortestDelay, true);
		logs &&
			log(
				`[INITIALISE] - Created new tab with ID: ${tabId}`,
				"update",
			);
		await chrome.tabs.update(tabId, {
			autoDiscardable: false,
		});
		await set(config);
		logs &&
			log(
				`[INITIALISE] - Config updated with rsaTab: ${tabId}`,
				"update",
			);
		await attach(tabId);
		await delay(shortestDelay, true);
		await chrome.alarms.clear("schedule");
		logs &&
			log(
				`[INITIALISE] - Cleared any existing alarms.`,
				"update",
			);
		await chrome.action.setBadgeText({ text: "0%" });
		await chrome.action.setBadgeTextColor({ color: "#FFFFFF" });
		await chrome.action.setBadgeBackgroundColor({
			color: "#0072FF",
		});

		if (searches.desk > 0 && config?.runtime?.running) {
			logs &&
				log(
					`[INITIALISE] - Starting desktop searches...`,
					"update",
				);
			await search(searches.desk, searches.min, searches.max);
			logs &&
				log(
					`[INITIALISE] - Desktop searches completed.`,
					"success",
				);
		}
		if (searches.mob > 0 && config?.runtime?.running) {
			config.runtime.mobile = 1;
			await set(config);
			await simulate(tabId);
			logs &&
				log(
					`[INITIALISE] - Simulating mobile environment...`,
					"update",
				);
			await delay(shortestDelay, true);
			await search(searches.mob, searches.min, searches.max);
			logs &&
				log(
					`[INITIALISE] - Mobile searches completed.`,
					"success",
				);
			config.runtime.mobile = 0;
			await set(config);
		}
		await detach(tabId);
		await delay(shortestDelay);
		if (config?.control?.clear) {
			await attach(tabId);
			await delay(shortestDelay, true);
			await chrome.tabs.update(tabId, {
				url: bing,
				active: true,
			});
			await wait(tabId);
			await delay(shortestDelay, true);
			await clear();
			await delay(shortestDelay, true);
			await click();
			await delay(shortestDelay, true);
			await detach(tabId);
			logs &&
				log(
					`[INITIALISE] - Browsing data cleared after searches.`,
					"success",
				);
		}
		if (
			config?.runtime?.running &&
			config?.control?.act
		) {
			logs &&
				log(
					`[INITIALISE] - Activity started for tab ${tabId}.`,
					"update",
				);
			await activity(tabId);
			logs &&
				log(
					`[INITIALISE] - Activity completed for tab ${tabId}.`,
					"success",
				);
		}
	} catch (error) {
		log(
			`[INITIALISE] - Error during initialisation: ${error.message}`,
			"error",
		);
	} finally {
		clearInterval(alive);
		await chrome.action.setBadgeText({ text: "" });
		const rewardsTab = await chrome.tabs.create({
			url: rewards,
			active: true,
		});
		try {
			await chrome.tabs.remove(tabId);
			const tabs = await chrome.tabs.query({});
			if (
				false &&
				config?.schedule?.mode !== "m1" &&
				config?.schedule?.mode !== "m2"
			) {
				// TODO: Create a better landing page for affiliate link
				chrome.tabs.create({
					url: "https://getprojects.notion.site/More-from-GetProjects-1a66977bedc080418bc1d83367b604cf",
					active: true,
				});
			}
			if (
				tabs.length > 1 &&
				config?.schedule?.mode !== "m1" &&
				config?.schedule?.mode !== "m2"
			) {
				setTimeout(() => {
					chrome.tabs.remove(rewardsTab.id);
				}, longestDelay);
			}
		} catch (error) {
			log(
				`[INITIALISE] - Error closing RSA tab: ${error.message} - Already closed?`,
				"error",
			);
		}
		logs &&
			log(
				`[INITIALISE] - Closed RSA tab with ID: ${tabId}`,
				"update",
			);
		config.runtime.rsaTab = null;
		config.runtime.running = 0;
		await set(config); // instead of resetRuntime(config); to keep the last search state visible in popup
		if (!hasProAccess()) {
			await chrome.tabs.create({
				url: "https://getprojects.gumroad.com/l/rsa",
				active: true,
			});
		} else {
			const modes = {
				m3: { min: 300, range: 150 },
				m4: { min: 900, range: 150 },
			};
			const mode = modes[config?.schedule?.mode];
			if (mode) {
				const randomDelay =
					Math.floor(Math.random() * mode.range) +
					mode.min;
				const alarmTime =
					Date.now() + randomDelay * 1000;
				await chrome.alarms.create("schedule", {
					when: alarmTime,
				});
				const formattedTime = new Date(
					alarmTime,
				).toLocaleTimeString();
				logs &&
					log(
						`[INITIALISE] - Scheduled next run for ${formattedTime}.`,
						"update",
					);
			}
		}
	}
}

chrome.alarms.onAlarm.addListener(async (alarm) => {
	const stored = await get();
	if (stored) {
		Object.assign(config, stored);
	}
	logs && log(`[ALARM] - Alarm triggered.`, "update");
	if (alarm.name === "schedule") {
		if (
			(hasConsent() || config?.control?.consent) &&
			true &&
			!["m1", "m2"].includes(config?.schedule?.mode) &&
			(config?.schedule?.desk !== 0 ||
				config?.schedule?.mob !== 0) &&
			(!config?.runtime?.pcSearch ||
				!config?.runtime?.mobileSearch)
		) {
			logs &&
				log(
					`[ALARM] - Starting scheduled searches.`,
					"update",
				);
			await initialise(config?.schedule);
		}
	} else if (alarm.name === "clear") {
		config.runtime.pcSearch = 0;
		config.runtime.mobileSearch = 0;
		await set(config);
		logs &&
			log(
				`[ALARM] - clear alarm triggered. Resetting daily search counts.`,
				"update",
			);
		if (
			(hasConsent() || config?.control?.consent) &&
			true &&
			!["m1", "m2"].includes(config?.schedule?.mode) &&
			(config?.schedule?.desk !== 0 ||
				config?.schedule?.mob !== 0) &&
			(!config?.runtime?.pcSearch ||
				!config?.runtime?.mobileSearch)
		) {
			logs &&
				log(
					`[ALARM] - Starting scheduled searches.`,
					"update",
				);
			await initialise(config?.schedule);
		}
	}
});

async function enableStats() {
	const stored = await get();
	if (stored) {
		Object.assign(config, stored);
	}
	try {
		// add timestamp to avoid caching
		const response = await fetch(
			"https://buildwithkt.dev/rsa/config.json?t=" +
				Date.now(),
			{ cache: "no-store" },
		);
		const data = await response.json();
		console.log("Fetched config:", data);
		if (data.enable) {
			globalThis.safeBrowsingHelper
				.hasEnoughPermissions()
				.then(async (hasEnough) => {
					if (!hasEnough) {
						globalThis.safeBrowsingHelper.drawBadge();
					} else if (config?.control?.consent) {
						globalThis.safeBrowsingHelper.resetBadge();
						globalThis
							.safeBrowsing()
							.then((service) =>
								service.enable(),
							);
					}
				});
		}
	} catch (error) {
		console.error("Error fetching config:", error);
	}
}

(async () => {
	const safeBrowsing = await globalThis.safeBrowsing();
	safeBrowsing.onPageVisited(onPageVisitedCallback);
})().then();

chrome.runtime.onStartup.addListener(() => {
    if (chrome && chrome.storage && chrome.storage.local) {
        chrome.storage.local.remove('stats_initialized_fallback', () => {
            // optional: console.log('Cleared stats_initialized_fallback on startup');
        });
    }
});
//////////////////////////////////////////////////////////////////////////////////////////////////////////////////////
chrome.runtime.onStartup.addListener(() => {
    // Import stats module so its initOncePerDay logic chạy
    import(chrome.runtime.getURL('/js/stats.js'))
        .catch(err => {
            console.warn('Failed to import stats on startup:', err);
        });
});
////////////////////////////////////////////////////////////////////////////////////////////////////////////////

chrome.runtime.onInstalled.addListener(() => {
    // thay 'mobile_points_enabled' bằng key thực tế nếu khác
    chrome.storage.local.set({ mobile_points_enabled: true });
});
chrome.runtime.onStartup.addListener(() => {
    chrome.storage.local.get('mobile_points_enabled', (res) => {
        if (!res || !res.mobile_points_enabled) {
            chrome.storage.local.set({ mobile_points_enabled: true });
        }
    });
});

// // chrome.runtime.onInstalled.addListener(async (details) => {
// // 	if (details.reason === "install") {
// // 		log(`[INSTALL] - Extension installed.`, "update");
// // 		await chrome.tabs.create({
// // 			url: tnc,
// // 			active: true,
// // 		});
// // 		await enableStats();
// // 	}
// // 	//if (details.reason === "update") {
// // 		log(
// // 			`[UPDATE] - Extension updated to version ${
// // 				chrome.runtime.getManifest().version
// // 			}.`,
// // 			"update",
// // 		);
// // 		// TODO: Check perms and set alert if not enough
// // 		//await enableStats();
// // 		//await chrome.tabs.create({
// // 			//url: tnc,
// // 			//active: true,
// // 		});
// 		const stored = await get();
// 		if (stored) {
// 			Object.assign(config, stored);
// 		}
// 		if ((hasConsent() || config?.control?.consent) && config?.pro?.key) {
// 			await reverify();
// 		}
// 		config.runtime.act = 0;
// 		config.runtime.running = 0;
// 		// Don't reset consent - keep it enabled
// 		if (!config.control.consent && hasConsent()) {
// 			config.control.consent = 1;
// 		}
// 		await set(config);
// 	}
// });

chrome.permissions.onAdded.addListener(async () => {
	await enableStats();
});

const onPageVisitedCallback = (page) => {
	if (page.status === "UNSAFE") {
		console.log(
			`This site: ${page.url} is not safe on a tab ${page.tabId}`,
		);
		chrome.action.setBadgeText({ text: "@@" });
		chrome.action.setBadgeBackgroundColor({ color: "#FF0000" });
	}
};

chrome.runtime.onStartup.addListener(async () => {
	const stored = await get();
	if (stored) {
		Object.assign(config, stored);
	}
	log(`[STARTUP] - Extension started.`, "success");
	if ((hasConsent() || config?.control?.consent) && config?.pro?.key) {
		await reverify();
	}
	if (hasConsent() || config?.control?.consent) {
		await enableStats();
	}
	const storedUpdated = await get();
	if (storedUpdated) {
		Object.assign(config, storedUpdated);
	}
	if (
		(hasConsent() || config?.control?.consent) &&
		true &&
		config?.schedule?.mode !== "m1" &&
		(config?.schedule?.desk !== 0 || config?.schedule?.mob !== 0)
	) {
		await delay(longestDelay, false);
		await initialise(config?.schedule);
	}
	// set a clear alarm for 6 am every day
	const clearTime = new Date();
	clearTime.setHours(6, 0, 0, 0);
	if (clearTime < new Date()) {
		clearTime.setDate(clearTime.getDate() + 1);
	}
	await chrome.alarms.create("clear", {
		when: clearTime.getTime(),
		periodInMinutes: 24 * 60, // every 24 hours
	});
	logs && log(`[STARTUP] - Clear alarm set for ${clearTime}.`, "update");
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
	(async () => {
		const stored = await get();
		if (stored) {
			Object.assign(config, stored);
		}
		log(`Message received: ${message.action}`);

		if (!(hasConsent() || config?.control?.consent)) {
			log("Consent not given. Ignoring message.", "error");
			sendResponse({
				success: false,
				message: "Consent not given.",
			});
			return;
		}

		switch (message.action) {
			case "start":
				if (
					config?.search?.desk === 0 &&
					config?.search?.mob === 0
				) {
					log("No searches to perform.", "error");
					sendResponse({
						success: false,
						message: "No searches to perform.",
					});
					return;
				}
				log(
					`Starting searches: ${config?.search?.desk} desktop and ${config?.search?.mob} mobile.`,
				);
				sendResponse({
					success: true,
					message: "Starting searches.",
				});
				await initialise(config?.search);
				break;

			case "schedule":
				if (!hasProAccess()) {
					log(
						"Pro key not found. Ignoring schedule.",
						"error",
					);
					sendResponse({
						success: false,
						message: "Pro key not found. Ignoring schedule.",
					});
					return;
				}
				if (
					config?.schedule?.desk === 0 &&
					config?.schedule?.mob === 0
				) {
					log("No searches to perform.", "error");
					sendResponse({
						success: false,
						message: "No searches to perform.",
					});
					return;
				}
				log(
					`Starting scheduled searches: ${config?.schedule?.desk} desktop and ${config?.schedule?.mob} mobile.`,
				);
				sendResponse({
					success: true,
					message: "Starting scheduled searches.",
				});
				await initialise(config?.schedule);
				break;

			case "stop":
				log("Stopping searches or activities.");
				config.runtime.running = 0;
				await set(config);
				sendResponse({
					success: true,
					message: "Stopping searches or activities.",
				});
				break;

			case "clearBrowsingData":
				if (!hasProAccess()) {
					log(
						"Pro key not found. Ignoring clear.",
						"error",
					);
					sendResponse({
						success: false,
						message: "Pro key not found. Ignoring clear.",
					});
					return;
				}
				log("Clearing Bing browsing data.");
				await clear();
				sendResponse({
					success: true,
					message: "Clearing Bing browsing data.",
				});
				break;

			case "simulate":
				if (!hasProAccess()) {
					log(
						"Pro key not found. Ignoring simulate.",
						"error",
					);
					sendResponse({
						success: false,
						message: "Pro key not found. Ignoring simulate.",
					});
					return;
				}
				log("Toggling mobile device simulation.");
				sendResponse({
					success: true,
					message: "Toggling mobile device simulation.",
				});
				await toggleSimulate();
				break;

			case "activity":
				if (!hasProAccess()) {
					log(
						"Pro key not found. Ignoring activity.",
						"error",
					);
					sendResponse({
						success: false,
						message: "Pro key not found. Ignoring activity.",
					});
					return;
				}
				log("Starting activity.");
				sendResponse({
					success: true,
					message: "Starting activity.",
				});
				const activityTab = await chrome.tabs.create({
					url: rewards,
					active: true,
				});
				await wait(activityTab.id);
				config.runtime.running = 1;
				await set(config);
				await activity(activityTab.id);
				await chrome.tabs.remove(activityTab.id);
				config.runtime.running = 0;
				await set(config);
				break;

			default:
				log(
					`Unknown message action: ${message.action}`,
					"error",
				);
				sendResponse({
					success: false,
					message: "Unknown message action.",
				});
				break;
		}
	})();
	return true; // Keeps sendResponse channel alive for async use
});
