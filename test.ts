import { GoogleGenAI } from "@google/genai";

const ai = new GoogleGenAI({});

async function main() {
    const response = await ai.models.generateContent({
        model: "gemini-3.5-flash",
        contents: [
            `extract all relevant PRIMARY vehicle data from : 
            Autotrader cars

Skip to content
Skip to footer
Saved
Sign in
CarsVansBikesMotorhomesCaravansTrucksFarmPlantElectric bikes
Main site menu
Vehicle types

Currently in the cars channel

Used cars
New cars
Sell your car
Value your car
Car reviews
Car leasing
Electric cars
Buy a car online
Back to results
57
Gallery

From Lindale Motors

Oldham
171 miles away
4.9
More seller information

Available to reserve

2013 Audi S3
2.0 TFSI S Tronic quattro Euro 6 (s/s) 3dr

£9,995

£502 below market average

Great price
Use the finance calculator
Overview
Bigger boot
Faster acceleration
Top 25%

Mileage

114,777 miles

Registration

2013 (63 reg)

Fuel type

Petrol

Body type

Hatchback

Engine

2.0L

Gearbox

Automatic

Doors

3

Seats

5

Emission class

Euro 6

Body colour

Black

View all spec and features
Description

2 KEYS | TIMING CHAIN DONE AT 93K, Excellent example of the Audi S3 Quattro finished in metallic black with Alcantara and pearl Nappa leather sports interior. Powered by the superb 2.0 TFSI turbo engine with S Tronic automatic gearbox and legendary Quattro four wheel drive system delivering outstanding performance and handling.

Main extras include:

Quattro Four Wheel Drive
S Tronic Automatic Gearbox
18" Alloy Wheels
Heated Front Sports Seats
Alcantara & Pearl Nappa Leather Interior
Satellite Navigation
DAB Digital Radio
Bluetooth Phone Preparation
Audi Drive Select
Xenon Headlights
LED Rear Lights
Rear Parking Sensors
Dual Zone Climate Control
Ambient Interior Lighting
Flat Bottom Multifunction Steering Wheel
Electric Heated Mirrors
Automatic Headlights & Wipers
Privacy Glass
S3 Styling Package
Rear Spoiler
Keyless Remote Locking
Tyre Pressure Monitoring
ISOFIX Child Seat Points

Excellent performance with superb handling and everyday practicality. Very clean and well maintained example that drives exceptionally well with fantastic Audi build quality throughout.

Ready to drive away today.

Read full description
Running costs

CO₂ emissions

159g/km

Insurance group

36E

Tax per year

£275

View all running costs
Insurance for 2013 Audi S3

Compare insurance quotes from 190+ trusted UK insurers.*

Get your quote

Powered by

This vehicle’s history

Owners

Contact seller

Keys

Contact seller

Service history

Contact seller

Basic history check

5 checks passed

Not recorded as stolen
Not recorded as scrapped
Not imported from another country
Not exported out of the UK
Never been written off
View all checks and history
Meet the seller

Lindale Motors

Oldham

•

171 miles

4.9
Visit seller website
(0161) 506 2466
Message
Get directions
Show location
Visit seller profile
View more seller information
Delivery and collection

Visit this car today

Oldham • 

171 miles away

Get directions

Delivery available
Can be delivered to BT1 5AD

Free

Request Home Delivery
How delivery works
Before you buy

Work out some of the most important costs for this car before you go ahead

Get a part exchange quote
Get a free, no-commitment Autotrader guide price for your old car
Buy a complete history check
Get peace of mind with a complete picture of this vehicle’s history and a data guarantee of up to £30,000. All for £5.95.
Use the finance calculator
See how much this car might cost per month with a quote from Zuto, our trusted finance broker
More vehicles from this seller
Carousel slide 1
Mazda Mazda2

1.3 TS Euro 4 3dr

£995

5 seats
3 doors
Hatchback
Petrol
Manual
1.3 litres
20
Carousel slide 2
Toyota Auris

1.6 VVT-i TR 5dr

£1,695

5 seats
5 doors
Hatchback
Petrol
Manual
1.6 litres
20
Carousel slide 3
Ford Mondeo

2.0 TDCi Titanium X Business Edition Euro 5 5dr

£1,995

Great price
5 seats
5 doors
Hatchback
Diesel
Manual
2.0 litres
20
Carousel slide 4
SEAT Toledo

1.2 TSI SE Euro 5 (s/s) 5dr (Nav)

£2,695

Great price
5 seats
5 doors
Hatchback
Petrol
Manual
1.2 litres
20
View more vehicles from Lindale Motors
Buying a car safely

Learn how to stay safe and protect your money with our handy guide

Read our guide on buying safely
Monthly finance price example
No finance options available

We couldn’t find any results for the terms you have entered.

Don’t worry, finance may still be available. Contact Zuto for more information.

Representative APR 16.9%

Get a quote now, no impact on your credit score.

Get a quote
Work out your monthly payment
Provided by

Zuto are car finance experts. They are a credit broker, not a lender and work with a wide range of lenders to find the most suitable finance deal for you.

Zuto Limited is authorised and regulated by the Financial Conduct Authority, registration number 452589.

How do Zuto offer finance?
Who can get car finance?
Will Zuto earn commission?
Will Autotrader earn commission?
Your next steps
Reserve now

Reserve the car for a refundable £99. We'll keep your money safe and always return it!

Build a deal

Personalise your deal online, with the option to add part exchange and explore payment options.

Reserve now

Contact seller

(0161) 506 2466
Message

Back to top
of the page

Security advice
Contact us
About Autotrader
Careers
Investor information
Privacy notice and cookies
Terms & conditions
Review policy
External wellbeing support
Manage cookies
Products & services
Buying advice
Quick search
Autotrader for dealers

Help us improve our website

Send feedback
Copyright © Autotrader Limited 2026.
Autotrader Limited (trading as Autotrader) is authorised and regulated by the Financial Conduct Authority. Our FCA firm reference number is 735711. Our FCA authorisation includes credit broking and insurance introductions. We are not a lender. Read more about our role and about fees and commissions
Registered office and headquarters
No.3 Circle Square
3 Hawkshaw Street
Manchester
M1 7BL
United Kingdom
Registered number: 03909628
            `,
        ],
        config: {
            tools: [{ urlContext: {} }],
        },
    });
    console.log(response.text);

    // For verification, you can inspect the metadata to see which URLs the model retrieved
    console.log(response.candidates[0].urlContextMetadata)
}

await main();