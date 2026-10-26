# carpool planner

**try it here → https://wiraare.github.io/carpool/**

so basically this is a website that figures out carpools. you put in where everyone's going, who's driving and how many seats they've got, and who needs a ride. then it works out who should pick up who and the best order to do it, so nobody's driving way out of their way.

i made it because planning rides for a group is always a mess of group chats and "wait who's getting me?"

## what it does

- **matches riders to drivers** using actual drive times from google, not just straight lines on a map. this matters a lot around the sound (bremerton looks close to seattle but it really isn't lol)
- **plans each car's route** with the best pickup order, plus when to leave and what time each person gets picked up if you set an arrive-by time
- **live traffic** so the times are actually realistic, and it shows slow parts in orange and jams in red
- **"open in google maps"** button for each driver so they can just hit go on their phone
- **use my location** if you don't wanna type your address
- **saved people** so you can just type someone's name and their address fills in (only saved in your own browser)
- **fewest cars mode** if you'd rather not have 5 cars going to the same place
- **addresses stay private** (more on that below)

## how to use it

1. open the site and put in where you're going
2. add yourself and anyone else you know about
3. hit **copy share link** and send it to the group chat
4. everyone opens it, adds themselves, and sends their link back to you
5. open the links they send you, they all get merged into your trip
6. hit **plan carpools** and send each driver their google maps link

## privacy

people's home addresses are private by default. whoever starts the trip is the only one who can see them. everyone else just sees names.

how it works: when you start a trip your browser makes a key pair. the public half goes in the share link and the private half never leaves your browser. every address gets locked with the public half, so only your browser can unlock them. so even if someone forwards the link to a random person, they can't see where anyone lives.

**heads up:** plan the trip in the same browser you started it in. if you clear your browser data, you can't unlock those addresses anymore and people would have to add themselves again.

## is it free?

yep. the site is hosted free on github pages, and the google maps stuff stays inside google's free monthly amount. the app also counts its own google requests and stops itself way before it'd cost anything.

## running your own copy

if you want to run it yourself with your own google key:

1. get a key from [google cloud console](https://console.cloud.google.com) and turn on these:
   - Maps JavaScript API
   - Geocoding API
   - Routes API
   - Places API (New)
2. lock the key to your site's address (Websites restriction) and set daily limits, because anyone who opens the site can see the key
3. paste it into `config.js`
4. host the folder anywhere. github pages works, or just run `python -m http.server` in the folder and go to `localhost:8000`

there's no build step or anything, it's just html, css and js.

## files

- `index.html` - the page
- `app.js` - everything that actually does stuff
- `style.css` - how it looks
- `config.js` - the google key and places you can find by name (like tlc church)
