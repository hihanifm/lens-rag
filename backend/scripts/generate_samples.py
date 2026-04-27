"""Generate sample Excel files for LENS demo projects."""

import os
import random
import pandas as pd

OUT_DIR = os.path.join(os.path.dirname(__file__), '..', 'samples')
os.makedirs(OUT_DIR, exist_ok=True)

random.seed(42)

# ── Product Catalog ────────────────────────────────────────────────────────

CATEGORIES = {
    'Electronics': {
        'Laptops': [
            ('ThinkPad X1 Carbon', '14" ultralight business laptop with Intel Core i7, 16GB RAM, 512GB SSD. Excellent keyboard and long battery life.', 'Intel Core i7-1365U, 16GB LPDDR5, 512GB NVMe, 14" IPS 1920x1200'),
            ('MacBook Air M2', '13.6" fanless laptop with Apple M2 chip. Outstanding performance per watt with up to 18 hours battery.', 'Apple M2, 8GB unified memory, 256GB SSD, 13.6" Liquid Retina'),
            ('Dell XPS 15', '15.6" OLED creator laptop with NVIDIA GPU. Ideal for photo and video editing on the go.', 'Intel Core i9-13900H, 32GB DDR5, 1TB NVMe, NVIDIA RTX 4060'),
            ('HP Spectre x360', '13.5" convertible 2-in-1 with OLED touchscreen. Versatile form factor for professionals.', 'Intel Core i7-1255U, 16GB LPDDR4, 512GB NVMe, 13.5" OLED'),
            ('ASUS ROG Zephyrus G14', '14" gaming laptop with AMD Ryzen 9 and dedicated GPU. Compact powerhouse for gamers.', 'AMD Ryzen 9 7940HS, 16GB DDR5, 1TB SSD, NVIDIA RTX 4060'),
        ],
        'Monitors': [
            ('LG UltraWide 34"', '34" curved ultrawide monitor for immersive multitasking. HDR support and USB-C connectivity.', '34" IPS, 3440x1440, 144Hz, HDR400, USB-C 65W'),
            ('Dell UltraSharp 27"', '27" 4K IPS monitor with factory-calibrated colors. Ideal for design and content creation.', '27" IPS, 3840x2160, 60Hz, 99% sRGB, USB-C 90W'),
            ('Samsung Odyssey G7', '32" curved gaming monitor with 240Hz refresh rate and 1ms response time.', '32" VA, 2560x1440, 240Hz, 1ms, HDR600'),
            ('BenQ PD3220U', '32" 4K Thunderbolt 3 display for Mac and PC professionals. Excellent color accuracy.', '32" IPS, 3840x2160, 60Hz, 100% sRGB, Thunderbolt 3'),
            ('ASUS ProArt PA279CV', '27" 4K monitor with 100% sRGB and hardware calibration for creative professionals.', '27" IPS, 3840x2160, 60Hz, 100% sRGB, USB-C 65W'),
        ],
    },
    'Office Supplies': {
        'Chairs': [
            ('Herman Miller Aeron', 'Ergonomic mesh office chair with lumbar support and PostureFit SL. Industry benchmark for comfort.', 'Mesh back and seat, adjustable arms, lumbar, tilt limiter, 12-year warranty'),
            ('Steelcase Leap V2', 'Highly adjustable task chair with LiveBack technology that mimics spine movement.', 'Flexible back, adjustable arms/height/depth, lumbar, 12-year warranty'),
            ('Secretlab Titan XL', 'Gaming chair with magnetic memory foam pillow and 4D armrests. Suitable for larger users.', 'Cold-cure foam, 4D arms, multi-tilt, magnetic pillows, 5-year warranty'),
            ('IKEA Markus', 'Budget ergonomic chair with built-in lumbar support and breathable mesh back.', 'Mesh back, fixed lumbar, adjustable height, 10-year warranty'),
            ('Autonomous ErgoChair Pro', 'Fully adjustable ergonomic chair with separate lumbar and headrest controls.', 'Woven mesh, 5D arms, adjustable lumbar/headrest, tilt limiter'),
        ],
        'Desks': [
            ('Flexispot E7 Pro', 'Electric sit-stand desk with dual motor and programmable height presets.', 'Dual motor, 55-60" top, 58-123cm height range, 355lb capacity'),
            ('IKEA Bekant', 'Classic office desk with optional underframe. Clean Scandinavian design at affordable price.', '160x80cm top, optional cable management, 10-year warranty'),
            ('Uplift V2', 'Premium standing desk with ANSI/BIFMA certified frame and extensive customization options.', 'Dual motor, up to 80" top, keypad presets, 15-year warranty'),
            ('Autonomous SmartDesk Pro', 'Affordable motorized standing desk with clean design and four memory presets.', 'Dual motor, 53x29" top, 64-129cm range, 4 presets'),
            ('Fully Jarvis', 'Popular standing desk with bamboo top option and wide height range for tall users.', 'Single motor, 48-72" top option, 60.5-129cm height, 7-year warranty'),
        ],
    },
    'Networking': {
        'Routers': [
            ('Ubiquiti UniFi Dream Machine Pro', 'Enterprise-grade all-in-one router with IDS/IPS and 10G SFP+. Ideal for SMB.', '10G SFP+, 1G WAN/LAN x8, 3.5GHz quad-core, IDS/IPS'),
            ('TP-Link Archer AXE75', 'Wi-Fi 6E tri-band router with 6GHz band support. Great range for large homes.', 'AXE5400, 6GHz band, 6x antennas, MU-MIMO, 4x Gbit LAN'),
            ('ASUS ZenWiFi Pro ET12', 'Tri-band Wi-Fi 6E mesh system with dedicated backhaul. Excellent whole-home coverage.', 'AXE11000, 6GHz backhaul, 2.5G WAN/LAN, up to 5,400 sq ft per node'),
            ('Netgear Orbi RBK863S', 'Quad-band Wi-Fi 6E mesh with dedicated 6GHz backhaul. Premium whole-home solution.', 'AXE9000, 6GHz backhaul, 2.5G WAN, covers up to 9,000 sq ft (3-pack)'),
            ('MikroTik hEX S', 'Compact gigabit router with SFP port and RouterOS. Excellent value for enthusiasts.', '5x Gbit, SFP, 880MHz dual-core, 256MB RAM, RouterOS'),
        ],
        'Switches': [
            ('Ubiquiti UniFi Switch 24 PoE', '24-port managed PoE switch with 250W budget. Integrates with UniFi ecosystem.', '24x Gbit PoE+, 2x SFP, 250W PoE budget, fanless'),
            ('Cisco SG350-28', '28-port Layer 3 managed switch with IPv6 and static routing. SMB workhorse.', '24x Gbit, 2x combo SFP, 2x SFP, Layer 3, 100-240V'),
            ('TP-Link TL-SG108PE', '8-port PoE+ smart switch with VLAN and QoS. Great for small office deployments.', '8x Gbit, 4x PoE+, 55W budget, VLAN, QoS, web-managed'),
            ('Netgear GS308E', '8-port smart managed switch with VLAN, QoS, and loop detection.', '8x Gbit, VLAN, QoS, loop detection, fanless, web-managed'),
            ('Mikrotik CRS328-24P', '24-port PoE switch with SFP+ uplinks and SwOS/RouterOS dual boot.', '24x Gbit PoE+, 4x SFP+, 500W PoE, SwOS/RouterOS'),
        ],
    },
}

STATUSES = ['Active', 'Active', 'Active', 'Discontinued', 'Limited Stock']

rows = []
pid = 1001
for cat, subcats in CATEGORIES.items():
    for subcat, products in subcats.items():
        for name, desc, specs in products:
            rows.append({
                'Product ID': f'PROD-{pid}',
                'Category': cat,
                'Subcategory': subcat,
                'Name': name,
                'Description': desc,
                'Specs': specs,
                'Price (USD)': round(random.uniform(49, 3499), 2),
                'Status': random.choice(STATUSES),
            })
            pid += 1

# Pad to ~100 rows by repeating with slight variation
base = rows.copy()
while len(rows) < 100:
    r = random.choice(base).copy()
    r['Product ID'] = f'PROD-{pid}'
    r['Price (USD)'] = round(r['Price (USD)'] * random.uniform(0.85, 1.15), 2)
    r['Status'] = random.choice(STATUSES)
    rows.append(r)
    pid += 1

pd.DataFrame(rows[:100]).to_excel(os.path.join(OUT_DIR, 'product_catalog.xlsx'), index=False)
print(f'  product_catalog.xlsx — {len(rows[:100])} rows')


# ── IT Asset Inventory ─────────────────────────────────────────────────────

ASSET_TYPES = {
    'Server': [
        ('Dell', 'PowerEdge R740', 'Dual Xeon Gold 6226R, 256GB RAM, 12x 4TB SAS RAID. Production database server.'),
        ('HPE', 'ProLiant DL380 Gen10', 'Dual Xeon Silver 4214, 128GB RAM, 8x 2TB SAS. Application server.'),
        ('Supermicro', 'SYS-6029P-WTR', 'Dual Xeon Gold 5218, 192GB RAM, all-flash NVMe. Hypervisor host.'),
        ('Lenovo', 'ThinkSystem SR650', 'Dual Xeon Platinum 8260, 384GB RAM. ML training server.'),
    ],
    'Laptop': [
        ('Apple', 'MacBook Pro 14" M2 Pro', '12-core CPU, 19-core GPU, 32GB RAM, 1TB SSD. Engineering workstation.'),
        ('Dell', 'XPS 15 9530', 'Core i9-13900H, 32GB, 1TB, RTX 4060. Developer workstation.'),
        ('Lenovo', 'ThinkPad X1 Carbon Gen 11', 'Core i7-1365U, 16GB, 512GB. Standard business laptop.'),
        ('HP', 'EliteBook 840 G10', 'Core i5-1345U, 16GB, 512GB. Finance department standard.'),
    ],
    'Network Device': [
        ('Cisco', 'Catalyst 9300-48P', '48-port PoE+ switch, 4x SFP+. Core access layer switch.'),
        ('Ubiquiti', 'UniFi Dream Machine Pro', 'Enterprise gateway with IDS/IPS, 10G uplink. Main office router.'),
        ('Palo Alto', 'PA-820', 'Next-gen firewall, 1Gbps threat prevention. Perimeter security.'),
        ('Aruba', '6300M 48G CL4', '48-port PoE switch with 4x QSFP28 uplinks. Data centre ToR.'),
    ],
    'Workstation': [
        ('Apple', 'Mac Pro M2 Ultra', '24-core CPU, 76-core GPU, 192GB RAM. Video production.'),
        ('Dell', 'Precision 7960', 'Xeon W-2400, 128GB ECC, RTX A4000. CAD/simulation workstation.'),
        ('HP', 'Z4 G5', 'Core i9-13900K, 64GB DDR5, RTX 3090. 3D rendering workstation.'),
        ('Lenovo', 'ThinkStation P360', 'Core i9-12900K, 64GB, A2000. Developer workstation tower.'),
    ],
    'Storage': [
        ('Synology', 'RS3621RPxs', '16-bay rackmount NAS, dual 10GbE, 256GB RAM. File server.'),
        ('QNAP', 'TS-h1886XU-RP', '18-bay NAS with ZFS and 25GbE. Backup storage.'),
        ('NetApp', 'AFF A250', 'All-flash array, 69.6TB raw. Primary storage cluster.'),
        ('Pure Storage', 'FlashArray//C60', '100% NVMe all-flash, 737TB raw. DR site storage.'),
    ],
}

LOCATIONS = ['London HQ', 'New York Office', 'Singapore Office', 'Remote', 'Data Centre A', 'Data Centre B']
STATUSES_IT = ['In Use', 'In Use', 'In Use', 'In Storage', 'Decommissioned', 'In Repair']
OWNERS = ['IT Dept', 'Engineering', 'Finance', 'HR', 'Sales', 'Marketing', 'DevOps', 'Security']

rows = []
aid = 1
for atype, assets in ASSET_TYPES.items():
    for manufacturer, model, notes in assets:
        rows.append({
            'Asset ID': f'IT-{aid:04d}',
            'Type': atype,
            'Manufacturer': manufacturer,
            'Model': model,
            'Location': random.choice(LOCATIONS),
            'Status': random.choice(STATUSES_IT),
            'Assigned To': random.choice(OWNERS),
            'Notes': notes,
        })
        aid += 1

base = rows.copy()
while len(rows) < 100:
    r = random.choice(base).copy()
    r['Asset ID'] = f'IT-{aid:04d}'
    r['Location'] = random.choice(LOCATIONS)
    r['Status'] = random.choice(STATUSES_IT)
    r['Assigned To'] = random.choice(OWNERS)
    rows.append(r)
    aid += 1

pd.DataFrame(rows[:100]).to_excel(os.path.join(OUT_DIR, 'it_assets.xlsx'), index=False)
print(f'  it_assets.xlsx — {len(rows[:100])} rows')


# ── Book Library ───────────────────────────────────────────────────────────

BOOKS = [
    ('978-0-06-112008-4', 'To Kill a Mockingbird', 'Harper Lee', 'Fiction', 1960,
     'A gripping coming-of-age story set in the American South during the 1930s, exploring racial injustice through the eyes of young Scout Finch.',
     'classic, southern gothic, legal drama, race, childhood'),
    ('978-0-7432-7356-5', '1984', 'George Orwell', 'Dystopian Fiction', 1949,
     'A chilling vision of a totalitarian society where Big Brother watches every move and independent thought is a crime.',
     'dystopia, surveillance, totalitarianism, political, classic'),
    ('978-0-14-028329-7', 'The Great Gatsby', 'F. Scott Fitzgerald', 'Fiction', 1925,
     'A portrait of the Jazz Age through the story of the mysterious Jay Gatsby and his obsession with Daisy Buchanan.',
     'classic, american dream, jazz age, wealth, tragedy'),
    ('978-0-316-76948-0', 'The Catcher in the Rye', 'J.D. Salinger', 'Fiction', 1951,
     'Holden Caulfield narrates his days wandering New York City after being expelled from prep school, railing against the phoniness of adult society.',
     'classic, coming of age, alienation, youth, new york'),
    ('978-0-06-093546-9', 'To Kill a Mockingbird', 'Harper Lee', 'Fiction', 1960,
     'Pulitzer Prize-winning masterwork of honor and injustice in the deep South—and the heroism of one man in the face of blind and violent hatred.',
     'classic, justice, race, south, lawyer'),
    ('978-0-385-33348-1', 'The Handmaid\'s Tale', 'Margaret Atwood', 'Dystopian Fiction', 1985,
     'In the theocratic Republic of Gilead, fertile women called Handmaids are forced to bear children for the ruling class.',
     'dystopia, feminism, theocracy, speculative, political'),
    ('978-0-7432-7023-6', 'Harry Potter and the Philosopher\'s Stone', 'J.K. Rowling', 'Fantasy', 1997,
     'An orphaned boy discovers he is a wizard and begins his education at Hogwarts School of Witchcraft and Wizardry.',
     'fantasy, magic, school, adventure, children'),
    ('978-0-618-00222-3', 'The Lord of the Rings', 'J.R.R. Tolkien', 'Fantasy', 1954,
     'An epic quest to destroy the One Ring and defeat the dark lord Sauron, spanning the vast world of Middle-earth.',
     'fantasy, quest, epic, mythology, adventure'),
    ('978-0-525-55360-5', 'The Hitchhiker\'s Guide to the Galaxy', 'Douglas Adams', 'Science Fiction', 1979,
     'After Earth is demolished to make way for a hyperspace bypass, Arthur Dent is swept into a bewildering series of cosmic misadventures.',
     'sci-fi, comedy, satire, space, british'),
    ('978-0-671-72020-1', 'Foundation', 'Isaac Asimov', 'Science Fiction', 1951,
     'The fall of a galactic empire is predicted by mathematician Hari Seldon, who establishes a Foundation to preserve knowledge.',
     'sci-fi, galactic empire, mathematics, civilization, classic'),
    ('978-0-7432-5457-1', 'Dune', 'Frank Herbert', 'Science Fiction', 1965,
     'On the desert planet Arrakis, young Paul Atreides navigates political intrigue and his destiny as a messianic figure.',
     'sci-fi, desert, politics, religion, ecology'),
    ('978-0-06-196436-4', 'Thinking, Fast and Slow', 'Daniel Kahneman', 'Non-Fiction', 2011,
     'Nobel laureate Kahneman explains the two systems of thought — fast, intuitive thinking and slow, deliberate reasoning — and how they shape our decisions.',
     'psychology, behavioural economics, decision making, cognitive bias'),
    ('978-0-14-303943-3', 'Sapiens', 'Yuval Noah Harari', 'Non-Fiction', 2011,
     'A sweeping narrative of humanity\'s history, from the emergence of Homo sapiens in Africa to the present.',
     'history, anthropology, evolution, civilization, science'),
    ('978-0-385-49331-6', 'The Lean Startup', 'Eric Ries', 'Business', 2011,
     'A methodology for developing businesses and products that aims to shorten product development cycles through validated learning.',
     'business, startup, agile, product, entrepreneurship'),
    ('978-0-06-251587-2', 'Good to Great', 'Jim Collins', 'Business', 2001,
     'Research into why some companies make the leap to greatness while others don\'t, identifying key principles of sustained excellence.',
     'business, leadership, management, strategy, research'),
    ('978-1-59327-584-6', 'The Phoenix Project', 'Gene Kim', 'Technology', 2013,
     'A novel about IT, DevOps, and helping your business win. Follows Bill as he saves his company\'s IT department.',
     'devops, IT, novel, business, technology'),
    ('978-1-491-95038-7', 'Designing Data-Intensive Applications', 'Martin Kleppmann', 'Technology', 2017,
     'Deep dive into the principles behind reliable, scalable, and maintainable systems. Essential reading for backend engineers.',
     'databases, distributed systems, engineering, architecture'),
    ('978-0-13-468599-1', 'Clean Code', 'Robert C. Martin', 'Technology', 2008,
     'A handbook of agile software craftsmanship. Explains principles, patterns, and practices of writing clean, readable code.',
     'programming, software engineering, best practices, refactoring'),
    ('978-0-201-63361-0', 'Design Patterns', 'Gang of Four', 'Technology', 1994,
     'The classic catalog of 23 software design patterns. A fundamental reference for object-oriented software design.',
     'design patterns, OOP, software architecture, programming'),
    ('978-0-13-110362-7', 'The C Programming Language', 'Kernighan & Ritchie', 'Technology', 1988,
     'The definitive reference for the C programming language by its creators. Concise and still relevant decades later.',
     'C, programming, systems, classic, language'),
    ('978-0-7432-7357-2', 'Atomic Habits', 'James Clear', 'Self-Help', 2018,
     'A proven framework for improving every day by focusing on the aggregated gains of small habits rather than big goals.',
     'habits, productivity, self improvement, psychology, behaviour'),
    ('978-0-06-251218-5', 'Deep Work', 'Cal Newport', 'Self-Help', 2016,
     'Rules for focused success in a distracted world. Newport argues that the ability to focus without distraction is becoming increasingly rare.',
     'productivity, focus, work, distraction, skills'),
    ('978-0-525-53955-5', 'Educated', 'Tara Westover', 'Memoir', 2018,
     'A memoir about a woman who grows up in a survivalist family in rural Idaho and goes on to earn a PhD from Cambridge University.',
     'memoir, education, family, resilience, rural'),
    ('978-0-385-54734-9', 'Becoming', 'Michelle Obama', 'Memoir', 2018,
     'The memoir of former US First Lady Michelle Obama, tracing her journey from the South Side of Chicago to the White House.',
     'memoir, politics, inspiration, biography, america'),
    ('978-0-06-112009-1', 'The Alchemist', 'Paulo Coelho', 'Fiction', 1988,
     'A philosophical novel about a young Andalusian shepherd who travels to Egypt in search of treasure and discovers his personal legend.',
     'fable, philosophy, journey, destiny, spiritual'),
]

# Pad to 100
base_books = BOOKS.copy()
rows = []
isbn_counter = 9000
for i, b in enumerate(base_books):
    rows.append({
        'ISBN': b[0], 'Title': b[1], 'Author': b[2], 'Genre': b[3],
        'Year Published': b[4], 'Summary': b[5], 'Tags': b[6],
    })

while len(rows) < 100:
    b = random.choice(base_books)
    rows.append({
        'ISBN': f'978-0-{isbn_counter:06d}-0',
        'Title': b[1] + ' (Revised Edition)',
        'Author': b[2], 'Genre': b[3],
        'Year Published': b[4] + random.randint(1, 20),
        'Summary': b[5], 'Tags': b[6],
    })
    isbn_counter += 1

pd.DataFrame(rows[:100]).to_excel(os.path.join(OUT_DIR, 'book_library.xlsx'), index=False)
print(f'  book_library.xlsx — {len(rows[:100])} rows')


# ── HR Directory ───────────────────────────────────────────────────────────

DEPARTMENTS = {
    'Engineering': {
        'roles': ['Software Engineer', 'Senior Software Engineer', 'Staff Engineer', 'Engineering Manager', 'Principal Engineer'],
        'skills_pool': ['Python', 'Go', 'Rust', 'TypeScript', 'React', 'PostgreSQL', 'Kubernetes', 'Docker', 'AWS', 'GCP', 'System Design', 'REST APIs', 'GraphQL'],
        'bios': [
            'Backend specialist with a focus on distributed systems and high-throughput data pipelines.',
            'Full-stack engineer with expertise in React and Python. Enjoys developer tooling and improving CI/CD workflows.',
            'Infrastructure-focused engineer passionate about observability, reliability, and platform engineering.',
            'Experienced engineering leader who has scaled teams from 3 to 30 engineers across multiple product lines.',
            'Performance engineering specialist with deep experience in database query optimisation and caching strategies.',
        ]
    },
    'Product': {
        'roles': ['Product Manager', 'Senior Product Manager', 'Principal Product Manager', 'Director of Product', 'Product Analyst'],
        'skills_pool': ['Roadmap Planning', 'User Research', 'A/B Testing', 'SQL', 'Figma', 'Stakeholder Management', 'OKRs', 'Market Analysis'],
        'bios': [
            'Product manager with a background in UX research. Focuses on discovery, validation, and iterative delivery.',
            'Data-driven PM who bridges engineering and business stakeholders. Strong in defining metrics and measuring outcomes.',
            'Senior PM specialising in B2B SaaS products. Has launched 3 products from 0 to 1 in the past 5 years.',
            'Director of Product overseeing a portfolio of 4 product lines with 12 direct reports.',
            'Product analyst who transforms quantitative and qualitative insights into actionable product decisions.',
        ]
    },
    'Design': {
        'roles': ['UX Designer', 'Senior UX Designer', 'Product Designer', 'UX Researcher', 'Design Lead'],
        'skills_pool': ['Figma', 'User Research', 'Prototyping', 'Design Systems', 'Accessibility', 'Usability Testing', 'Motion Design', 'Interaction Design'],
        'bios': [
            'UX designer passionate about making complex products intuitive. Specialises in information architecture.',
            'Product designer who balances aesthetics with usability. Champion for accessibility and inclusive design.',
            'Senior designer with a background in graphic design who transitioned to digital product work.',
            'UX researcher specialising in qualitative methods — interviews, diary studies, and contextual inquiry.',
            'Design lead managing a team of 5 designers across web and mobile product surfaces.',
        ]
    },
    'Finance': {
        'roles': ['Financial Analyst', 'Senior Financial Analyst', 'Finance Manager', 'Controller', 'VP Finance'],
        'skills_pool': ['Financial Modelling', 'Excel', 'SQL', 'FP&A', 'IFRS', 'Budget Management', 'Forecasting', 'ERP Systems'],
        'bios': [
            'Financial analyst specialising in SaaS metrics — ARR, churn, LTV/CAC, and unit economics.',
            'Experienced FP&A professional who supports strategic decision-making with rigorous financial models.',
            'Finance manager overseeing accounts payable, receivable, and month-end close processes.',
            'Controller with deep expertise in IFRS compliance and audit preparation for Series B+ companies.',
            'VP Finance with a track record of leading finance functions through hypergrowth and public listings.',
        ]
    },
    'HR': {
        'roles': ['HR Business Partner', 'Recruiter', 'Senior Recruiter', 'HR Manager', 'Head of People'],
        'skills_pool': ['Talent Acquisition', 'Performance Management', 'HRIS', 'Employment Law', 'Onboarding', 'Compensation & Benefits', 'Diversity & Inclusion'],
        'bios': [
            'HR business partner supporting the engineering and product org. Focuses on performance and career development.',
            'Technical recruiter with a track record of closing senior engineers in competitive markets.',
            'Senior recruiter who has built hiring pipelines for GTM and commercial teams at high-growth startups.',
            'HR manager responsible for policies, compliance, and employee relations across 3 office locations.',
            'Head of People driving culture, engagement, and organisational design as the company scales.',
        ]
    },
}

LOCATIONS_HR = ['London', 'New York', 'Singapore', 'Remote', 'Berlin', 'Sydney']
FIRST_NAMES = ['Alice', 'Bob', 'Carol', 'David', 'Emma', 'Frank', 'Grace', 'Henry', 'Iris', 'Jack',
               'Kate', 'Liam', 'Mia', 'Noah', 'Olivia', 'Paul', 'Quinn', 'Rachel', 'Sam', 'Tina',
               'Uma', 'Victor', 'Wendy', 'Xavier', 'Yara', 'Zoe', 'Alex', 'Blake', 'Casey', 'Dana']
LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Martinez', 'Davis',
              'Wilson', 'Taylor', 'Anderson', 'Thomas', 'Jackson', 'White', 'Harris', 'Martin',
              'Thompson', 'Young', 'Allen', 'King', 'Wright', 'Scott', 'Green', 'Baker', 'Adams']

rows = []
emp_id = 1001
used_names = set()

for dept, info in DEPARTMENTS.items():
    for _ in range(20):
        while True:
            name = f'{random.choice(FIRST_NAMES)} {random.choice(LAST_NAMES)}'
            if name not in used_names:
                used_names.add(name)
                break
        skills = random.sample(info['skills_pool'], min(4, len(info['skills_pool'])))
        rows.append({
            'Employee ID': f'EMP-{emp_id}',
            'Name': name,
            'Department': dept,
            'Role': random.choice(info['roles']),
            'Location': random.choice(LOCATIONS_HR),
            'Skills': ', '.join(skills),
            'Bio': random.choice(info['bios']),
        })
        emp_id += 1

pd.DataFrame(rows[:100]).to_excel(os.path.join(OUT_DIR, 'hr_directory.xlsx'), index=False)
print(f'  hr_directory.xlsx — {len(rows[:100])} rows')


print('\nDone. Files written to backend/samples/')
