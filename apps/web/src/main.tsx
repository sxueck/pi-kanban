import { StrictMode, useState } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import { detectLocale, I18nContext, storeLocale, type Locale } from "./i18n.js";
import { App } from "./App.js";
import "./styles.css";

function Root() {
	const [locale, setLocale] = useState<Locale>(detectLocale);
	return (
		<I18nContext.Provider
			value={{
				locale,
				setLocale: (l) => {
					setLocale(l);
					storeLocale(l);
				},
			}}
		>
			<App />
		</I18nContext.Provider>
	);
}

createRoot(document.getElementById("root")!).render(
	<StrictMode>
		<BrowserRouter>
			<Root />
		</BrowserRouter>
	</StrictMode>,
);
