Swal.init({
  style: { backgroundColor: "#fff", textAlign: "center" },
  forceStyle: true,
});

// Listen for ad click from popup.js (to prevent false clicks)
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.type === "confirm-redirect" && request.url) {
    Swal.fire({
      title: "Are you sure?",
      text: `Do you want to visit this URL? \n\n ${request.url}`,
      icon: "warning",
      showCancelButton: true,
      confirmButtonText: "Yes, go!",
    }).then((result) => {
      if (result.isConfirmed) {
        window.open(request.url, "_blank");
      }
    });
  }
});
