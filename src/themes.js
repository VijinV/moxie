// Terminal colour schemes (Settings → Terminal → Theme).

const ansi = (black, red, green, yellow, blue, magenta, cyan, white, bBlack, bRed, bGreen, bYellow, bBlue, bMagenta, bCyan, bWhite) => ({
  black, red, green, yellow, blue, magenta, cyan, white,
  brightBlack: bBlack, brightRed: bRed, brightGreen: bGreen, brightYellow: bYellow,
  brightBlue: bBlue, brightMagenta: bMagenta, brightCyan: bCyan, brightWhite: bWhite,
});

export const THEMES = {
  moxie: {
    name: "Moxie Night",
    background: "#0d0f15", foreground: "#d6dae4", cursor: "#a78bfa", cursorAccent: "#0d0f15", selectionBackground: "#3b3363",
    ...ansi("#1b1e28", "#f7768e", "#9ece6a", "#e0af68", "#7aa2f7", "#bb9af7", "#7dcfff", "#c0caf5", "#565f89", "#ff8fa3", "#b9f27c", "#ffc777", "#8db0ff", "#c7a9ff", "#a4daff", "#e5e9f5"),
  },
  dracula: {
    name: "Dracula",
    background: "#282a36", foreground: "#f8f8f2", cursor: "#f8f8f2", cursorAccent: "#282a36", selectionBackground: "#44475a",
    ...ansi("#21222c", "#ff5555", "#50fa7b", "#f1fa8c", "#bd93f9", "#ff79c6", "#8be9fd", "#f8f8f2", "#6272a4", "#ff6e6e", "#69ff94", "#ffffa5", "#d6acff", "#ff92df", "#a4ffff", "#ffffff"),
  },
  nord: {
    name: "Nord",
    background: "#2e3440", foreground: "#d8dee9", cursor: "#d8dee9", cursorAccent: "#2e3440", selectionBackground: "#434c5e",
    ...ansi("#3b4252", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#88c0d0", "#e5e9f0", "#4c566a", "#bf616a", "#a3be8c", "#ebcb8b", "#81a1c1", "#b48ead", "#8fbcbb", "#eceff4"),
  },
  "one-dark": {
    name: "One Dark",
    background: "#282c34", foreground: "#abb2bf", cursor: "#528bff", cursorAccent: "#282c34", selectionBackground: "#3e4451",
    ...ansi("#282c34", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#abb2bf", "#5c6370", "#e06c75", "#98c379", "#e5c07b", "#61afef", "#c678dd", "#56b6c2", "#ffffff"),
  },
  gruvbox: {
    name: "Gruvbox Dark",
    background: "#282828", foreground: "#ebdbb2", cursor: "#ebdbb2", cursorAccent: "#282828", selectionBackground: "#504945",
    ...ansi("#282828", "#cc241d", "#98971a", "#d79921", "#458588", "#b16286", "#689d6a", "#a89984", "#928374", "#fb4934", "#b8bb26", "#fabd2f", "#83a598", "#d3869b", "#8ec07c", "#ebdbb2"),
  },
  "solarized-dark": {
    name: "Solarized Dark",
    background: "#002b36", foreground: "#839496", cursor: "#93a1a1", cursorAccent: "#002b36", selectionBackground: "#073642",
    ...ansi("#073642", "#dc322f", "#859900", "#b58900", "#268bd2", "#d33682", "#2aa198", "#eee8d5", "#586e75", "#cb4b16", "#586e75", "#657b83", "#839496", "#6c71c4", "#93a1a1", "#fdf6e3"),
  },
  "mobaxterm": {
    name: "Classic (black)",
    background: "#000000", foreground: "#e5e5e5", cursor: "#ffffff", cursorAccent: "#000000", selectionBackground: "#4d4d4d",
    ...ansi("#000000", "#cd0000", "#00cd00", "#cdcd00", "#3b78ff", "#cd00cd", "#00cdcd", "#e5e5e5", "#7f7f7f", "#ff0000", "#00ff00", "#ffff00", "#5c5cff", "#ff00ff", "#00ffff", "#ffffff"),
  },
  "github-light": {
    name: "GitHub Light",
    background: "#ffffff", foreground: "#24292f", cursor: "#0969da", cursorAccent: "#ffffff", selectionBackground: "#b6d7ff",
    ...ansi("#24292f", "#cf222e", "#116329", "#4d2d00", "#0969da", "#8250df", "#1b7c83", "#6e7781", "#57606a", "#a40e26", "#1a7f37", "#633c01", "#218bff", "#a475f9", "#3192aa", "#8c959f"),
  },
};

export const FONTS = [
  ["", "Cascadia Mono (default)"],
  ['"Cascadia Code"', "Cascadia Code (ligatures)"],
  ["Consolas", "Consolas"],
  ['"JetBrains Mono"', "JetBrains Mono"],
  ['"Fira Code"', "Fira Code"],
  ['"Source Code Pro"', "Source Code Pro"],
  ['"Courier New"', "Courier New"],
  ['"Lucida Console"', "Lucida Console"],
];
