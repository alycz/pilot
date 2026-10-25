import { describe, expect, it } from "vitest";

import { restOperationsEnabledForDeployment } from "../src/server";

describe("Free/QuickJS REST operation gate", () => {
	it("preserves existing paid behavior when the profile is absent or explicit", () => {
		expect(restOperationsEnabledForDeployment({})).toBe(true);
		expect(restOperationsEnabledForDeployment({
			HARBOR_DEPLOYMENT_PROFILE: "paid-dynamic",
		})).toBe(true);
	});

	it("disables every REST operation for Free and malformed explicit profiles", () => {
		expect(restOperationsEnabledForDeployment({
			HARBOR_DEPLOYMENT_PROFILE: "free-quickjs",
		})).toBe(false);
		expect(restOperationsEnabledForDeployment({
			HARBOR_DEPLOYMENT_PROFILE: "Free-QuickJS",
		})).toBe(false);
	});
});
