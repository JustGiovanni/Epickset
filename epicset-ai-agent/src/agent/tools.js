import { mockLibrary } from "../sandbox/mockLibrary.js";
import { searchYouTube } from "../youtube/youtubeClient.js";
import { v4 as uuid } from "uuid";

export const tools = {
  getUserLibrary: async () => {
    return mockLibrary;
  },

  searchYouTube: async ({ query }) => {
    return await searchYouTube(query);
  },

  importYouTubeTrack: async ({ title, duration }) => {
    return {
      id: uuid(),
      title,
      artist: "YouTube",
      duration
    };
  },

  createSetlist: async ({ name }) => {
    return {
      setlistId: uuid(),
      name
    };
  },

  addTrackToSetlist: async () => {
    return true;
  }
};
