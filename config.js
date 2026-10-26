// keys everyone uses so nobody has to get their own
//
// googleMapsKey: google cloud console > apis & services > credentials.
//   lock it to your site's address and set daily limits, anyone who opens
//   the site can see it
// wsdotCode: free at https://wsdot.wa.gov/traffic/api/ (optional)
window.CARPOOL_CONFIG = {
  googleMapsKey: 'AIzaSyA2B-ozIQ2C8RC9iyA2tTh0FeCxaI8_-8M',
  wsdotCode: '',
  // places anyone can find by name in the address boxes (public places only, not homes)
  places: [
    { name: 'TLC Church', aliases: ['tlc', 'The Living Christian Church'], addr: 'The Living Christian Church, 125 NE 185th St, Shoreline, WA 98155' },
  ],
};
