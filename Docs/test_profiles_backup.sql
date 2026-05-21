--
-- PostgreSQL database dump
--

\restrict Mt76FJxrRHX8o7FiJfjp6IvtUmcr2GrnmcZCDb3nabi0ZjN3Xir4YxdffaKlMZ6

-- Dumped from database version 17.6
-- Dumped by pg_dump version 18.4

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET transaction_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Data for Name: profiles; Type: TABLE DATA; Schema: public; Owner: -
--

COPY public.profiles (id, email, full_name, role, home_location_id, can_float, pin_code, is_active, created_at, updated_at, can_approve_compliance, must_change_password, is_salesperson) FROM stdin;
2adbeb08-df7e-464a-8839-c3fc16af055c	mbowers@skybolt.com	mbowers	machinist	\N	f	\N	t	2026-05-21 20:35:03.432757+00	2026-05-21 20:35:03.432757+00	f	f	f
82e2a436-481e-41e1-87f2-5bf30c350766	test-compliance@skybolt.com	test-compliance	compliance	\N	f	\N	t	2026-05-21 20:35:03.432757+00	2026-05-21 20:35:03.432757+00	t	f	f
6d58f1a8-fc36-4b9d-86f0-4f6c2e887961	test-customer-service@skynet.local	Customer Service	customer_service	\N	f	\N	t	2026-05-21 20:35:03.432757+00	2026-05-21 20:35:03.432757+00	f	f	f
100ddd82-31b5-4aa8-b712-7ae951518814	test-finishing@skybolt.com	test-finishing	finishing	\N	f	\N	t	2026-05-21 20:35:03.432757+00	2026-05-21 20:35:03.432757+00	f	f	f
a541a228-d4b9-433c-b433-2042815152ad	test-machinist@skybolt.com	test-machinist	machinist	\N	f	\N	t	2026-05-21 20:35:03.432757+00	2026-05-21 20:35:03.432757+00	f	f	f
da9eae4d-5b27-4c9e-9a25-97983535825f	test-president@skynet.local	Ned Bowers	president	\N	f	\N	t	2026-05-21 20:35:03.432757+00	2026-05-21 20:35:03.432757+00	f	f	f
7aa1a996-eaef-4587-ac0a-994d4a6e881a	test-scheduler@skybolt.com	test-scheduler	scheduler	\N	f	\N	t	2026-05-21 20:35:03.432757+00	2026-05-21 20:35:03.432757+00	f	f	f
01a74787-d0fa-43d9-9dd4-0e77407004b0	tsales@skynet.local	Test Sales	customer_service	\N	f	\N	t	2026-05-21 20:35:03.432757+00	2026-05-21 20:35:03.432757+00	f	f	t
df3e7efe-6660-40dd-956c-69bcbcdc46fb	tuser@skynet.local	Test User	machinist	\N	f	\N	t	2026-05-21 20:35:03.432757+00	2026-05-21 20:35:03.432757+00	f	f	f
004b6b6e-68cf-4824-bf52-db9d15468745	mabowers84@gmail.com	Matt Bowers	admin	\N	f	9999	t	2026-05-21 20:35:03.432757+00	2026-05-21 20:35:49.442977+00	t	f	f
\.


--
-- PostgreSQL database dump complete
--

\unrestrict Mt76FJxrRHX8o7FiJfjp6IvtUmcr2GrnmcZCDb3nabi0ZjN3Xir4YxdffaKlMZ6

