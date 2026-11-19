// keys everyone uses so nobody has to get their own
//
// googleMapsKey: never put the real key here, the repo is public.
//   it lives in the repo's GOOGLE_MAPS_KEY secret and the deploy
//   (.github/workflows/pages.yml) swaps it in. lock the key to the site's
//   address in google cloud, since anyone who opens the site can still see it
window.CARPOOL_CONFIG = {
  googleMapsKey: '__GOOGLE_MAPS_KEY__',
  // logUrl: the web app link of the log script in log-server/ (blank = no logging)
  logUrl: '',
  // places anyone can find by name in the address boxes (public places only, not homes)
  places: [
    { name: 'TLC Church', aliases: ['tlc', 'The Living Christian Church'], addr: 'The Living Christian Church, 125 NE 185th St, Shoreline, WA 98155' },
  ],
};
