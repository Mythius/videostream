const { ipcRenderer } = require('electron');

// Expose the selectDirectory function to the renderer
window.selectDirectory = async () => {
  return await ipcRenderer.invoke('select-directory');
};
