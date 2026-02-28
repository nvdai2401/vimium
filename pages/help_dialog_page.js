import "./all_content_scripts.js";
import * as UIComponentMessenger from "./ui_component_messenger.js";
import { allCommands } from "../background_scripts/all_commands.js";

// The ordering we show key bindings is alphanumerical, except that special keys sort to the end.
function compareKeys(a, b) {
  a = a.replace("<", "~");
  b = b.replace("<", "~");
  if (a < b) {
    return -1;
  } else if (b < a) {
    return 1;
  } else {
    return 0;
  }
}

const ellipsis = "...";
// Truncates `s` and appends an ellipsis if `s` is longer than maxLength.
function ellipsize(s, maxLength) {
  if (s.length <= maxLength) return s;
  return s.substring(0, Math.max(0, maxLength - ellipsis.length)) + ellipsis;
}

// Returns true if the command should be labeled as "advanced" for UI purposes.
function isAdvancedCommand(command, options) {
  // Use some bespoke logic to label some command + option combos as advanced.
  return command.advanced ||
    (command.name == "reload" && options.includes("hard"));
}

const HelpDialogPage = {
  dialogElement: null,

  init() {
    if (this.dialogElement != null) {
      return;
    }
    this.dialogElement = document.querySelector("#dialog");

    const closeButton = this.dialogElement.querySelector("#close");
    closeButton.addEventListener("click", (event) => {
      event.preventDefault();
      this.hide();
    }, false);

    // "auxclick" handles a click with the middle mouse button.
    const optionsLink = document.querySelector("#options-page");
    for (const eventName of ["click", "auxclick"]) {
      optionsLink.addEventListener(eventName, (event) => {
        event.preventDefault();
        chrome.runtime.sendMessage({ handler: "openOptionsPageInNewTab" });
      }, false);
    }

    document.documentElement.addEventListener("click", (event) => {
      if (!this.dialogElement.contains(event.target)) {
        this.hide();
      }
    }, false);

    const searchInput = document.querySelector("#help-search");
    searchInput.addEventListener("input", () => this.filterCommands(searchInput.value));
  },

  filterCommands(query) {
    const normalizedQuery = query.toLowerCase().trim();
    const rows = this.dialogElement.querySelectorAll(".row");

    for (const row of rows) {
      if (!normalizedQuery) {
        row.classList.remove("search-hidden");
        continue;
      }
      const keys = row.querySelector(".key-bindings")?.textContent.toLowerCase() || "";
      const desc = row.querySelector(".help-description")?.textContent.toLowerCase() || "";
      const matches = keys.includes(normalizedQuery) || desc.includes(normalizedQuery);
      row.classList.toggle("search-hidden", !matches);
    }

    // Hide group headings if all their rows are hidden
    const groups = this.dialogElement.querySelectorAll("[data-group]");
    for (const group of groups) {
      const h2 = group.previousElementSibling;
      if (!h2 || h2.tagName !== "H2") continue;
      const visibleRows = group.querySelectorAll(".row:not(.search-hidden)");
      const hasVisible = visibleRows.length > 0;
      h2.classList.toggle("search-hidden", !hasVisible && !!normalizedQuery);
    }
  },

  // Returns the rows to show in the help dialog, grouped by command group.
  // Returns: { group: [[command, args, keys], ...], ... }
  getRowsForDialog(commandToOptionsToKeys) {
    const result = {};
    const byGroup = Object.groupBy(allCommands, (o) => o.group);
    for (const [group, commands] of Object.entries(byGroup)) {
      const list = [];
      for (const command of commands) {
        // Note that commands which are unbound won't be present in this data structure, and that's
        // desired; we don't want to show unbound commands in the help dialog.
        const variations = commandToOptionsToKeys[command.name] || {};
        for (const [options, keys] of Object.entries(variations)) {
          list.push([command, options, keys]);
        }
      }
      result[group] = list;
    }
    return result;
  },

  getRowEl(command, options, keys) {
    const rowTemplate = document.querySelector("template#row").content;
    const keysTemplate = document.querySelector("template#keys").content;

    const rowEl = rowTemplate.cloneNode(true);
    rowEl.querySelector(".help-description").textContent = command.desc;
    if (isAdvancedCommand(command, options)) {
      rowEl.querySelector(".row").classList.add("advanced");
    }
    const keysEl = rowEl.querySelector(".key-bindings");
    for (const key of keys.sort(compareKeys)) {
      const node = keysTemplate.cloneNode(true);
      node.querySelector(".key").textContent = key;
      keysEl.appendChild(node);
    }

    const maxLength = 40;
    const descEl = rowEl.querySelector(".help-description");
    let desc = command.desc;
    if (options != "") {
      const optionsString = ellipsize(options, maxLength - command.desc.length);
      desc += ` (${optionsString})`;
      const isTruncated = optionsString != options;
      if (isTruncated) {
        // Show the full option string on hover.
        descEl.title = `${command.desc} (${options})`;
      }
    }
    descEl.textContent = desc;
    return rowEl;
  },

  async show() {
    document.getElementById("vimium-version").textContent = Utils.getCurrentVersion();

    const commandToOptionsToKeys =
      (await chrome.storage.session.get("commandToOptionsToKeys")).commandToOptionsToKeys;
    const rowsByGroup = this.getRowsForDialog(commandToOptionsToKeys);

    for (const [group, rows] of Object.entries(rowsByGroup)) {
      const container = this.dialogElement.querySelector(`[data-group="${group}"]`);
      container.innerHTML = "";
      for (const [command, options, keys] of rows) {
        const el = this.getRowEl(command, options, keys);
        container.appendChild(el);
      }
    }

    const searchInput = document.querySelector("#help-search");
    searchInput.value = "";
    this.filterCommands("");
    searchInput.focus();
  },

  hide() {
    UIComponentMessenger.postMessage({ name: "hide" });
  },
};

function init() {
  UIComponentMessenger.init();
  UIComponentMessenger.registerHandler(async function (event) {
    await Settings.onLoaded();
    await Utils.populateBrowserInfo();
    switch (event.data.name) {
      case "hide":
        HelpDialogPage.hide();
        break;
      case "show":
        HelpDialogPage.init();
        await HelpDialogPage.show(event.data);
        // If we abandoned (see below) in a mode with a HUD indicator, then we have to reinstate it.
        Mode.setIndicator();
        break;
      case "hidden":
        // Abandon any HUD which might be showing within the help dialog.
        HUD.abandon();
        break;
      default:
        Utils.assert(false, "Unrecognized message type.", event.data);
    }
  });
}

globalThis.HelpDialogPage = HelpDialogPage;
globalThis.isVimiumHelpDialogPage = true;

const testEnv = globalThis.window == null;
if (!testEnv) {
  document.addEventListener("DOMContentLoaded", async () => {
    await Settings.onLoaded();
    DomUtils.injectThemeCss();
    DomUtils.injectUserCss(); // Manually inject custom user styles.
  });
  init();
}

export { HelpDialogPage };
