-- Automatically create the dedicated integration test database on initial container startup
SELECT 'CREATE DATABASE crewmesh_test OWNER crewmesh'
WHERE NOT EXISTS (SELECT FROM pg_database WHERE datname = 'crewmesh_test')\gexec
