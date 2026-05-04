import { useEffect, useState } from "react";
import { Moon, Sun } from "../icons";
import { IconButton } from "../ui/IconButton";
import { getCurrentTheme, setTheme, type Theme } from "../../lib/theme";

export function ThemeToggle() {
  const [theme, setLocal] = useState<Theme>(getCurrentTheme);

  useEffect(() => {
    setLocal(getCurrentTheme());
  }, []);

  function toggle() {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    setLocal(next);
  }

  return (
    <IconButton
      size="sm"
      label={theme === "dark" ? "Switch to light theme" : "Switch to dark theme"}
      onClick={toggle}
    >
      {theme === "dark" ? <Sun /> : <Moon />}
    </IconButton>
  );
}
