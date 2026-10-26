const { withEntitlementsPlist } = require("@expo/config-plugins");

// expo-notifications' config plugin, which Expo applies automatically whenever
// the package is installed, always writes the `aps-environment` entitlement.
// That entitlement is for REMOTE push, which Ateam Go has none of: task-wait
// reminders are local notifications the phone schedules itself (see
// src/wait-reminders.ts), and local notifications need no entitlement. Keeping
// it would make every signed build carry the Push Notifications capability for
// nothing. Remove this plugin if the app ever sends real push.
module.exports = function withoutPushEntitlement(config) {
	return withEntitlementsPlist(config, (cfg) => {
		delete cfg.modResults["aps-environment"];
		return cfg;
	});
};
