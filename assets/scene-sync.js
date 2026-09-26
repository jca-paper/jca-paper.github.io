(() => {
  "use strict";

  document.querySelectorAll("#scene-aware-mesh-animation .scene-grid").forEach(grid => {
    const videos = [...grid.querySelectorAll("video")];
    if (videos.length < 2) return;

    const leader = videos[0];
    const internalSeeks = new WeakSet();
    let state = "syncing";
    let wantsPlayback = true;
    let rate = 1;
    let operation = null;
    let frame = 0;

    function setState(next) {
      state = next;
      grid.dataset.playback = next;
    }

    function waitFor(video, predicate, signal) {
      return new Promise((resolve, reject) => {
        const events = ["loadedmetadata", "loadeddata", "canplay", "seeked", "progress", "error"];
        function cleanup() {
          events.forEach(event => video.removeEventListener(event, check));
          signal.removeEventListener("abort", check);
        }
        function check() {
          if (signal.aborted || video.error) {
            cleanup();
            reject(video.error || new DOMException("Superseded playback request", "AbortError"));
          } else if (predicate()) {
            cleanup();
            resolve();
          }
        }
        events.forEach(event => video.addEventListener(event, check));
        signal.addEventListener("abort", check);
        check();
      });
    }

    function seek(video, time) {
      if (Math.abs(video.currentTime - time) < 0.001) return;
      internalSeeks.add(video);
      video.currentTime = time;
    }

    function pauseAll() {
      wantsPlayback = false;
      operation?.abort();
      cancelAnimationFrame(frame);
      setState("paused");
      videos.forEach(video => video.pause());
    }

    function correctDrift() {
      if (state !== "playing") return;
      const time = leader.currentTime;
      if (!leader.seeking) {
        videos.slice(1).forEach(video => {
          if (!video.seeking && video.readyState >= 3 && Math.abs(video.currentTime - time) > 0.025) {
            seek(video, time);
          }
        });
      }
      frame = requestAnimationFrame(correctDrift);
    }

    async function synchronize(time, play) {
      operation?.abort();
      const current = new AbortController();
      operation = current;
      const { signal } = current;
      wantsPlayback = play;
      cancelAnimationFrame(frame);
      setState("syncing");
      videos.forEach(video => video.pause());

      try {
        await Promise.all(videos.map(video => waitFor(video, () => video.readyState >= 1, signal)));
        if (signal.aborted) return;
        const duration = Math.min(...videos.map(video => video.duration));
        const target = Math.max(0, Math.min(time, duration));
        videos.forEach(video => {
          video.playbackRate = rate;
          seek(video, target);
        });
        await Promise.all(videos.map(video => waitFor(video, () => !video.seeking && video.readyState >= 3, signal)));
        if (signal.aborted) return;
        if (!play) {
          setState("paused");
          return;
        }

        // Start every decoder in the same task after the shared readiness barrier.
        const results = await Promise.allSettled(videos.map(video => video.play()));
        if (signal.aborted) return;
        if (results.some(result => result.status === "rejected")) {
          pauseAll();
          return;
        }
        setState("playing");
        correctDrift();
      } catch (error) {
        if (!signal.aborted) pauseAll();
      }
    }

    videos.forEach(video => {
      // Native controls remain available; looping is coordinated for the group.
      video.autoplay = false;
      video.loop = false;
      video.preload = "auto";
      video.addEventListener("play", () => {
        if (state === "paused" && !video.paused) {
          const time = video.currentTime >= video.duration - 0.01 ? 0 : video.currentTime;
          void synchronize(time, true);
        }
      });
      video.addEventListener("pause", () => {
        if (state === "playing" && video.paused && !video.ended) pauseAll();
      });
      video.addEventListener("seeking", () => {
        if (state !== "syncing" && video.seeking && !internalSeeks.has(video)) {
          void synchronize(video.currentTime, wantsPlayback);
        }
      });
      video.addEventListener("seeked", () => internalSeeks.delete(video));
      video.addEventListener("waiting", () => {
        if (state === "playing" && !video.paused && video.readyState < 3 && !video.seeking && !internalSeeks.has(video)) {
          void synchronize(leader.currentTime, wantsPlayback);
        }
      });
      video.addEventListener("ended", () => {
        if (state === "playing" && wantsPlayback) void synchronize(0, true);
      });
      video.addEventListener("ratechange", () => {
        if (video.playbackRate !== rate) {
          rate = video.playbackRate;
          videos.forEach(other => { other.playbackRate = rate; });
        }
      });
      video.addEventListener("error", pauseAll);
    });

    document.addEventListener("visibilitychange", () => {
      if (!document.hidden && state === "playing") void synchronize(leader.currentTime, true);
    });
    void synchronize(0, true);
  });
})();
