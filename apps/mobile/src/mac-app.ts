// Ateam for Mac, from the phone: the page goes to the Mac (AirDrop, Messages, Notes)
// through the share sheet, since a phone can't install it and opening the page there
// leads nowhere.
import { Share } from "react-native";
import { MAC_APP_URL } from "./create-box";

export function shareMacApp(): void {
	void Share.share({ url: MAC_APP_URL }).catch(() => {});
}
