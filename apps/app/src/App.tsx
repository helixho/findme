import CloudWorkspace from "./CloudWorkspace";
import { cloudMode } from "./cloud-api";
import { PrivateOrLegacyApp } from "./native/PrivateOrLegacyApp";

export default function App() {
  return cloudMode ? <CloudWorkspace /> : <PrivateOrLegacyApp />;
}
