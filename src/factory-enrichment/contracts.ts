/** Historical observations, not Draken-added execution instructions. */
export interface Discovery {
  id: string;
  revision: string;
  locationKey: string;
  purpose: string;
  appliesWhen: string;
  method: string[];
  limitations: string[];
}
