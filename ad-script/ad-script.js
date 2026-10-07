(async function () {
	const container = document.getElementById("ad-banner-slider");
	if (!container) return;
	const ads = [
		{
			image: chrome.runtime.getURL("ad-script/imgs/ad1.png"),
			link: "https://play.google.com/store/apps/details?id=com.overthink.ai.fc",
		},
		{
			image: chrome.runtime.getURL("ad-script/imgs/ad2.png"),
			link: "https://apps.apple.com/us/app/overthink-ai/id6745426633",
		},
		// add as much as you want of banners here
	];

	// Style the container
	container.style.position = "relative";
	container.style.width = "calc(180px * var(--scale)) auto";
	container.style.height = "calc(60px * var(--scale))";
	container.style.margin = "auto";
	container.style.maxWidth = "calc(182px * var(--scale))";
	container.style.overflow = "hidden";
	// container.style.border = "1px solid #ccc";
	// container.style.borderRadius = "8px";

	// Show that's an ad placeholder
	const containerTitle = document.createElement("span");
	containerTitle.textContent = "Ad";
	containerTitle.style.position = "absolute";
	containerTitle.style.color = "black";
	containerTitle.style.fontWeight = "600";
	containerTitle.style.top = "calc(2px * var(--scale))";
	containerTitle.style.left = "calc(2px * var(--scale))";
	containerTitle.style.zIndex = "10000";
	container.appendChild(containerTitle);

	// Create wrapper
	const slider = document.createElement("div");
	slider.style.display = "flex";
	slider.style.transition = "transform 0.5s ease-in-out";
	slider.style.width = `${ads.length * 100}%`;
	container.appendChild(slider);

	// Add each ad
	for (const ad of ads) {
		const slide = document.createElement("a");
		slide.href = ad.link;
		slide.target = "_blank";
		slide.style.flex = "0 0 100%";
		slide.innerHTML = `<img src="${ad.image}" style="width:calc(182px * var(--scale)); height:calc(60px * var(--scale)); object-fit:contain; display:block;" alt="Ad">`;
		// show centered redirect confirmation SweetAlert2 inside the DOM
		slide.addEventListener("click", async (e) => {
			e.preventDefault();
			try {
				const [tab] = await chrome.tabs.query({
					active: true,
					currentWindow: true,
				});

				if (tab?.id) {
					await chrome.tabs.sendMessage(tab.id, {
						type: "confirm-redirect",
						url: ad.link,
					});
				}
			} catch (err) {
				console.log(
					"Couldn't send message to content script. Opening URL directly.",
					err,
				);
				chrome.tabs.create({ url: ad.link });
			}
		});

		slider.appendChild(slide);
	}

	// Auto-slide logic
	let index = 0;
	setInterval(() => {
		index = (index + 1) % ads.length;
		slider.style.transform = `translateX(-${index * 100}%)`;
	}, 4000);
})();
