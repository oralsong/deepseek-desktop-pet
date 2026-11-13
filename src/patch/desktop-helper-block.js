	const desktopActionBusy = new Set();
	const desktopRunAnim = (found) => {
		const actions = found?.conf?.animations?.moves?.actions;
		if (!Array.isArray(actions)) return "";
		const preferred = actions.find((item) => item && String(item.name || "").includes("\u5954\u8dd1"));
		const chosen = preferred || actions[0];
		return chosen && typeof chosen.name === "string" ? chosen.name : "";
	};
	const desktopPointAnim = (found) => {
		const candidates = [];
		const events = found?.conf?.animations?.events?.workStatus;
		if (Array.isArray(events)) {
			for (const slot of events) {
				if (Array.isArray(slot)) candidates.push(...slot);
				else if (typeof slot === "string") candidates.push(slot);
			}
		}
		const categories = found?.conf?.animations?.categories;
		if (Array.isArray(categories)) {
			for (const category of categories) {
				if (category && Array.isArray(category.actions)) candidates.push(...category.actions);
			}
		}
		return candidates.find((name) => /点按|\u6572\u51fb|\u70b9\u51fb/.test(String(name))) || "";
	};
	const desktopSay = async (petId, text) => {
		let cfg = null;
		try { cfg = (await __dshPetPeek.loadPeekConfig(userRoot)).cfg; } catch { }
		let spoke = null;
		if (cfg && cfg.speak === true && text && String(text).length <= 40) {
			spoke = await __dshPetPeek.speakLine(cfg, text, { play: false }).catch((e) => ({ ok: false, reason: "throw", message: e instanceof Error ? e.message : String(e) }));
		}
		state.writePet(petId, "say", { text });
		if (spoke && spoke.ok && spoke.file && cfg) void __dshPetPeek.playFile(cfg, spoke.file);
		return spoke;
	};
	const tryDesktopOpenCommand = async (petId, text, found) => {
		const query = __dshPetDesktop.parseDesktopOpenCommand(text);
		if (!query) return null;
		console.log("[dsh-pet:desktop] parsed command target=" + query + " pet=" + petId);
		if (desktopActionBusy.has(petId)) {
			return { ok: false, reason: "desktop-action-busy", message: "\u6211\u6b63\u5728\u5e2e\u4f60\u53bb\u5f00\u4e1c\u897f\uff0c\u7b49\u6211\u5230\u4e86\u518d\u8bf4\u3002" };
		}
		desktopActionBusy.add(petId);
		try {
			let foundIcon = await __dshPetDesktop.findDesktopTarget(query);
			if (!foundIcon.ok || !foundIcon.match) {
				console.log("[dsh-pet:desktop] local lookup failed, trying screen vision");
				try {
					const peekCfg = (await __dshPetPeek.loadPeekConfig(userRoot)).cfg;
					const frame = await __dshPetPeek.captureFrame({ ...peekCfg, maxWidth: Math.max(Number(peekCfg.maxWidth) || 0, 1600) });
					if (frame.ok) {
						const visual = await __dshPetPeek.locateScreenTarget(
							userRoot,
							petSystemPrompt(found),
							query,
							frame.shot,
							peekCfg.generateTimeoutMs
						);
						console.log("[dsh-pet:desktop] vision=" + JSON.stringify(visual));
						if (visual.ok && visual.found && Number(visual.confidence) >= 0.35) {
							const detailScreen = foundIcon.detail && foundIcon.detail.screen ? foundIcon.detail.screen : {};
							const screenWidth = Number(frame.screenWidth) || Number(detailScreen.width) || 1920;
							const screenHeight = Number(frame.screenHeight) || Number(detailScreen.height) || 1080;
							const screenX = Number(detailScreen.x) || 0;
							const screenY = Number(detailScreen.y) || 0;
							foundIcon = {
								ok: true,
								match: {
									name: visual.label || query,
									path: "",
									x: screenX + visual.x * screenWidth,
									y: screenY + visual.y * screenHeight,
									score: Math.round(Number(visual.confidence) * 1000),
									visible: true,
									source: "vision"
								},
								screen: { x: screenX, y: screenY, width: screenWidth, height: screenHeight },
								foreground: { desktop: false },
								source: "vision"
							};
						}
					}
				} catch (e) {
					console.log("[dsh-pet:desktop] vision failed=" + (e instanceof Error ? e.message : String(e)));
				}
			}
			if (!foundIcon.ok || !foundIcon.match) {
				console.log("[dsh-pet:desktop] lookup failed " + JSON.stringify(foundIcon));
				desktopActionBusy.delete(petId);
				const text = "\u684c\u9762\u548c\u5f53\u524d\u753b\u9762\u91cc\u90fd\u6ca1\u627e\u5230\u201c" + query + "\u201d\uff0c\u8bf7\u786e\u8ba4\u5b83\u6b63\u5728\u5c4f\u5e55\u4e0a\u53ef\u89c1\u3002";
				const spoke = await desktopSay(petId, text);
				return {
					ok: false,
					reason: foundIcon.reason || "desktop-target-not-found",
					message: text,
					...(spoke && spoke.ok ? { spoke: { ok: true, seconds: spoke.seconds, file: spoke.file } } : {})
				};
			}
			const match = foundIcon.match;
			const actionSource = String(match.source || foundIcon.source || "desktop");
			const screen = foundIcon.screen || {};
			const targetName = String(match.name || query).replace(/\.(?:exe|lnk|url)$/i, "");
			const targetPath = typeof match.path === "string" ? match.path : "";
			const screenX = Number(screen.x);
			const screenY = Number(screen.y);
			const screenW = Number(screen.width);
			const screenH = Number(screen.height);
			const iconX = Number(match.x);
			const iconY = Number(match.y);
			const hasPoint = Number.isFinite(iconX) && Number.isFinite(iconY) && screenW > 0 && screenH > 0;
			console.log("[dsh-pet:desktop] target=" + targetName + " source=" + actionSource + " point=" + (hasPoint ? iconX + "," + iconY : "missing") + " path=" + (targetPath || "missing"));
			const petSize = Number(found?.pet?.size) || 462;
			const pointAnim = desktopPointAnim(found);
			const finish = () => {
				const run = async () => {
					let clicked = false;
					let launched = false;
					try {
						if (pointAnim) {
							try { state.writePet(petId, "anim", { name: pointAnim }); } catch { }
							console.log("[dsh-pet:desktop] point animation=" + pointAnim);
							await new Promise((resolve) => setTimeout(resolve, 650));
						}
						if (hasPoint) {
							clicked = (await __dshPetDesktop.doubleClickScreenPoint(iconX, iconY)).ok === true;
							if (!clicked && actionSource !== "vision") {
								clicked = (await __dshPetDesktop.invokeDesktopTarget(targetName)).ok === true;
							}
						}
						if (!clicked && targetPath) launched = (await __dshPetDesktop.launchDesktopTarget(targetPath)).ok === true;
						console.log("[dsh-pet:desktop] finished clicked=" + clicked + " launched=" + launched);
						state.writePet(petId, "say", {
							text: clicked || launched ? "\u5f00\u597d\u5566\u3002" : "\u70b9\u4e0b\u53bb\u4f46\u597d\u50cf\u6ca1\u53cd\u5e94\uff0c\u4f60\u770b\u4e00\u4e0b\u8fdb\u7a0b\u3002"
						});
					} finally {
						desktopActionBusy.delete(petId);
					}
				};
				void run();
			};

			let duration = 900;
			if (hasPoint) {
				const leftHalf = iconX < screenX + screenW / 2;
				const offset = Math.max(54, petSize * 0.42);
				const current = pose.get(petId);
				const cursor = await __dshPetDesktop.getCursorPosition();
				const handOffset = leftHalf ? -offset : offset;
				const handOffsetY = Math.round(petSize * 0.08);
				const targetPetX = Math.min(screenX + screenW * 0.9, Math.max(screenX + screenW * 0.1, iconX - handOffset));
				const targetPetY = Math.min(screenY + screenH * 0.9, Math.max(screenY + screenH * 0.1, iconY - handOffsetY));
				const targetNx = (targetPetX - screenX) / screenW;
				const targetNy = (targetPetY - screenY) / screenH;
				const runAnim = desktopRunAnim(found);
				if (cursor.ok && current) {
					const pickupX = Math.min(screenX + screenW * 0.9, Math.max(screenX + screenW * 0.1, cursor.x - handOffset));
					const pickupY = Math.min(screenY + screenH * 0.9, Math.max(screenY + screenH * 0.1, cursor.y - handOffsetY));
					const pickupNx = (pickupX - screenX) / screenW;
					const pickupNy = (pickupY - screenY) / screenH;
					const pickupDistance = Math.hypot((pickupNx - current.x) * screenW, (pickupNy - current.y) * screenH);
					const pickupDuration = Math.max(900, Math.min(8000, Math.round(pickupDistance / 0.16)));
					const carryDistance = Math.hypot(iconX - cursor.x, iconY - cursor.y);
					const carryDuration = Math.max(1800, Math.min(12000, Math.round(carryDistance / 0.16)));
					duration = pickupDuration + (pointAnim ? 500 : 120) + carryDuration;
					state.writePet(petId, "position", {
						x: pickupNx,
						y: pickupNy,
						mode: "line",
						duration: pickupDuration,
						motion: "run",
						...(runAnim ? { anim: runAnim } : {}),
						facing: cursor.x >= current.x * screenW + screenX ? "right" : "left"
					});
					console.log("[dsh-pet:desktop] pickup mouse pet=" + petId + " cursor=" + cursor.x + "," + cursor.y + " duration=" + pickupDuration);
					setTimeout(() => {
						if (pointAnim) {
							try { state.writePet(petId, "anim", { name: pointAnim }); } catch { }
						}
						setTimeout(() => {
							state.writePet(petId, "position", {
								x: targetNx,
								y: targetNy,
								mode: "line",
								duration: carryDuration,
								motion: "run",
								carryCursor: true,
								handOffsetX: handOffset,
								handOffsetY,
								...(runAnim ? { anim: runAnim } : {}),
								facing: iconX >= cursor.x ? "right" : "left"
							});
							console.log("[dsh-pet:desktop] carrying mouse to=" + iconX + "," + iconY + " duration=" + carryDuration);
							setTimeout(finish, carryDuration);
						}, pointAnim ? 500 : 120);
					}, pickupDuration);
				} else {
					const distance = current ? Math.hypot((targetNx - current.x) * screenW, (targetNy - current.y) * screenH) : 0;
					duration = current ? Math.max(2200, Math.min(12000, Math.round(distance / 0.16))) : 4800;
					state.writePet(petId, "position", {
						x: targetNx,
						y: targetNy,
						mode: "line",
						duration,
						motion: "run",
						...(runAnim ? { anim: runAnim } : {}),
						facing: leftHalf ? "right" : "left"
					});
					console.log("[dsh-pet:desktop] cursor unavailable, direct run duration=" + duration);
					setTimeout(finish, duration);
				}
			} else {
				setTimeout(finish, 250);
			}
			const opening = hasPoint
				? (actionSource === "vision" ? "\u6211\u770b\u5230\u4e86\uff0c\u8fd9\u5c31\u8dd1\u8fc7\u53bb\u70b9" : "\u8fd9\u5c31\u8dd1\u8fc7\u53bb\u5e2e\u4f60\u6253\u5f00") + targetName
				: "\u684c\u9762\u56fe\u6807\u6682\u65f6\u6293\u4e0d\u5230\u5750\u6807\uff0c\u6211\u76f4\u63a5\u5e2e\u4f60\u6253\u5f00" + targetName;
			const spoke = await desktopSay(petId, opening);
			return {
				ok: true,
				text: opening,
				action: { kind: "desktop-open", target: targetName, source: actionSource, moved: hasPoint, duration },
				...(spoke && spoke.ok ? { spoke: { ok: true, seconds: spoke.seconds, file: spoke.file } } : {})
			};
		} catch (e) {
			desktopActionBusy.delete(petId);
			return { ok: false, reason: "desktop-action-error", message: e instanceof Error ? e.message : String(e) };
		}
	};
