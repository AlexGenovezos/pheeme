let track = null;
let status = "Connect Spotify in this mod’s settings.";
let refreshing = false;

async function render() {
  const text = track
    ? `${track.name} — ${track.artists.map((artist) => artist.name).join(", ")}`
    : status;
  await pheeme.render("settings", [
    {
      type: "text",
      text: "Connect your Spotify account below, then open the Spotify panel or use its command to save a track.",
    },
  ]);
  await pheeme.render("panel", [
    { type: "text", text },
    { type: "text", text: status },
    { type: "button", id: "refresh", label: "Refresh track" },
    { type: "button", id: "heart", label: "♡ Save track", disabled: !track },
  ]);
  await pheeme.render("compact", [
    { type: "text", text },
    { type: "button", id: "heart", label: "♡ Save track", disabled: !track },
  ]);
}

async function refresh() {
  if (refreshing) return;
  refreshing = true;
  try {
    if (!(await pheeme.connections.status("spotify")).connected) {
      track = null;
      status = "Connect Spotify in this mod’s settings.";
    } else {
      const response = await pheeme.http.request({
        url: "https://api.spotify.com/v1/me/player/currently-playing",
        connection: "spotify",
      });
      if (response.status === 204) {
        track = null;
        status = "Nothing is playing.";
      } else if (response.status === 200) {
        const playing = JSON.parse(response.body);
        track = playing.currently_playing_type === "track" ? playing.item : null;
        status = track ? "Ready to save." : "Play a music track in Spotify.";
      } else {
        track = null;
        status = `Spotify returned ${response.status}. Check your account’s API access.`;
      }
    }
  } catch {
    track = null;
    status = "Couldn’t reach Spotify. Check your connection or reconnect in Settings.";
  } finally {
    refreshing = false;
    await render();
  }
}

pheeme.on("refresh", refresh);
pheeme.on("heart", async () => {
  // Refresh first so a palette action saves the track currently playing.
  await refresh();
  if (!track || refreshing) return;
  try {
    const response = await pheeme.http.request({
      url: `https://api.spotify.com/v1/me/library?uris=${encodeURIComponent(track.uri || `spotify:track:${track.id}`)}`,
      method: "PUT",
      connection: "spotify",
    });
    status =
      response.status >= 200 && response.status < 300
        ? "♥ Saved to your Spotify library."
        : `Couldn’t save this track (${response.status}).`;
  } catch {
    status = "Couldn’t save the track. Try again.";
  }
  await render();
});
pheeme.every(15000, refresh);
refresh();
