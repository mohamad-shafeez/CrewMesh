-- Automatically create dedicated integration test and isolated load-test databases on container startup
SELECT 'CREATE DATABASE crewmesh_test OWNER crewmesh'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'crewmesh_test')\gexec

SELECT 'CREATE DATABASE crewmesh_loadtest OWNER crewmesh'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'crewmesh_loadtest')\gexec
